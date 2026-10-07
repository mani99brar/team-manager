"""Push each new record of the controller's attention feed to the operator through the configured notify command, and the
presence flag that says whether they are working or away (RUNBOOK "Attention notifications").

`python -m workflow attention-notify` is a oneshot, run every minute by a systemd user timer. It reads `attention.jsonl`
(beside the Projects registry, as attention.feed_path finds it) from the byte offset saved in `attention-notify.state.json`,
groups the complete new lines by run in feed order, folds each run's records into one message (title `md-manager`, body one
line per record `[run_id] kind: text`, each text cut at TEXT_LIMIT characters and the body at BODY_LIMIT; or, with
`"format": "html"` in `notify.json`, a Telegram HTML message: an emoji and a bold title line naming the run and its state,
one line per record, what the operator has to do, the commands the records carry as tappable code and copy buttons, and
`/verb_run@bot` commands for the panel; see "Message format"), runs the argv of `notify.json` with the title and the body
as its last two arguments, appends one line `{at, sent_at, run_id, kind}` per
pushed record to `attention-notified.jsonl`, then saves the offset. The command reads no secret: delivery, the channels and
their tokens stay in the configured command.

At most CAP messages go out per rolling hour across all runs. Past the cap a run's lines are held in the state file; the
next run sends one digest (`N more records`, then the lines) for what is held, which counts as a send, and exactly one such
digest goes out per full window: after it, the held lines wait until a slot frees. While the presence flag reads `away`,
only the kinds that wait on the operator (IMMEDIATE) are pushed at once; the other kinds are held and go out as one digest
when the flag reads `working` again. Only sent messages count toward the cap.

The offset moves only once every message of the pass was sent: a send that fails (non-zero exit, a timeout, a command
that is not there) prints one line to stderr and exits 2 with the offset where it was. The state remembers what went by
record, never by byte span: `pushed` holds the key (`run_id`, `at`, `kind`, `node`) of every record a message of the
pass carried, kept while a send fails and cleared once every message went. The next pass reads again from the offset
to the end of the feed, skips the records whose key is in `pushed` (and those already held for a digest), plans the
rest and sends them, so a record that did go out is not repeated and one appended meanwhile is not lost, even when the
operator edited or deleted a line under the retry. The pass stops at the first refusal: the records of runs whose first
unsent record follows the refused line wait, unlost. A line the channel keeps refusing is retried every minute, and the
systemd unit shows the failure, until the operator edits that line's text or deletes the line (the RUNBOOK says how;
never an earlier line, and never the state file). A feed shorter than the offset (truncated or replaced) is read from
the start; a trailing line without its newline waits for the next run; a complete line that is not a record is reported
and skipped. A missing or malformed `notify.json`, or a feed that cannot be read, is the same one-line stderr and exit 2
with nothing sent. The feed is read with a plain open and never its lock, so a controller writing a record never waits
on a notify call. A second instance at once (the timer and a run by hand) finds `attention-notify.lock` held, says so
and exits 0.

Message format (`"format": "html"`). The body is Telegram HTML (parse_mode HTML, which the command gets as
`NOTIFY_PARSE_MODE=HTML` in its environment, with the inline keyboard as JSON in `NOTIFY_REPLY_MARKUP` when the message
has buttons): every piece of record text is escaped (`<`, `>`, `&`) before a tag touches it, so a record quoting
`--accept-challenge "<reason>"` is sent as written. The title line is the kind's emoji, then bold `<run id> · <state>`,
the state being that of the first record that waits on the operator (IMMEDIATE), else the last record's. Each record is
one line, the node in bold, the text with the home folder shortened to `~` and the run's folder to its id, cut at a word.
The `python -m workflow …` commands the text carries are listed as `<code>` lines (tap copies them) and as `copy_text`
inline buttons; the text before the first command is the line's prose. The footer says what to do (`👉 …`, per kind)
and lists the panel's commands, `/<verb>_<run>@<bot>` with `"bot"` from `notify.json` (a group needs the bot named; the
run id with every other character folded to `_`, kept under Telegram's 32 characters), which the operator's panel
reads as `<verb> <run>` (agent-workflow `panel/CLAUDE.md`). A session record (agent-workflow's session hook, kinds
`pane` and `finished`, text `[tab] event: …`) gets the event's emoji and state (permission prompt, turn ended) and the tab
title in italics; `**bold**` and `` `code` `` in a reply are turned into tags. A digest is `📬 <b>N more records</b>` and one
line per record with its run in bold, no commands. The plain format is the default, byte for byte what it was.

Topic names. A run's topic is named `<emoji> <run id> · <feature in plain words>` (the first clause of the feature.json
`name` in the run's source checkout, else the feature slug as words); a session's `<emoji> <pane title>` (the record's
`title`, the Herdr pane's terminal title). The emoji is the state's. The state keeps `{thread, name}` per run and, with
`rename` in `topic`, renames the topic when the name changes (another state, another pane title).

`python -m workflow presence [working|away] [--for 9h]` reads or writes `presence.json`: `{"status", "since", "until"}`.
`--for` sets `until`, after which the status reads `working` again; a missing or malformed file reads `working`.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import html
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .attention import FEED, KINDS, iso
from .registry import registry_path
from .sessions import read_json, save_json

VERSION = "1.0.0"
STATE = "attention-notify.state.json"
LOCK = "attention-notify.lock"
CONFIG = "notify.json"
PRESENCE = "presence.json"
NOTIFIED = "attention-notified.jsonl"
TITLE = "md-manager"
TEXT_LIMIT = 300
BODY_LIMIT = 3500
CAP = 10
WINDOW_SECONDS = 3600
TIMEOUT_SECONDS = 30
# Pushed at once while the operator is away: each waits on a decision or a pane of theirs. The other kinds are held.
IMMEDIATE = frozenset({"question", "pane", "challenge_paused", "review_blocked", "controller_blocked", "awaiting_approval"})
HELD = KINDS - IMMEDIATE
DURATION = re.compile(r"(\d+(?:\.\d+)?)([smhd])")
UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}
PLAIN, HTML = "plain", "html"
BOT_NAME = re.compile(r"[A-Za-z0-9_]{1,32}")


class NotifyError(Exception):
    """What ends the command with one stderr line and exit 2."""


def config_dir(env: dict | None = None) -> Path:
    """Every file of the feature lives beside the Projects registry: MD_MANAGER_PROJECTS_CONFIG's folder, else ~/.config/md-manager/."""
    return registry_path(env).parent


def parse_iso(value) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# --- presence ---------------------------------------------------------------------------------------------------------

def load_presence(folder: Path) -> dict:
    """The file's `{status, since, until}`, or {} for a missing or malformed one."""
    try:
        value = read_json(folder / PRESENCE)
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) and value.get("status") in ("working", "away") else {}


def presence_status(folder: Path, now: float) -> str:
    """`away` while the file says so and its `until` (when set) is still ahead; `working` otherwise."""
    presence = load_presence(folder)
    if presence.get("status") != "away":
        return "working"
    until = parse_iso(presence.get("until"))
    if presence.get("until") is not None and (until is None or until <= now):
        return "working"
    return "away"


def parse_duration(text: str) -> float:
    """`9h`, `30m`, `2d`, `45s` or a combination such as `1h30m`, in seconds."""
    parts = DURATION.findall(text or "")
    if not parts or "".join(amount + unit for amount, unit in parts) != text or sum(float(amount) for amount, _ in parts) <= 0:
        raise ValueError(f"--for wants a duration such as 9h, 30m or 1h30m, not {text!r}")
    return sum(float(amount) * UNITS[unit] for amount, unit in parts)


def describe_presence(folder: Path, now: float) -> str:
    presence = load_presence(folder)
    status = presence_status(folder, now)
    if presence.get("status") == "away":
        until = presence.get("until")
        if status == "away":
            return f"away since {presence.get('since')}" + (f" until {until}" if until else "")
        return f"working (away until {until} passed)"
    return "working" + (f" since {presence.get('since')}" if presence.get("since") else "")


def presence_main(argv: list[str], *, env: dict | None = None, clock=time.time) -> None:
    parser = argparse.ArgumentParser(prog="python -m workflow presence", description="Read or set whether the operator is working or away")
    parser.add_argument("status", nargs="?", choices=("working", "away"), help="The new status; prints the current one when omitted")
    parser.add_argument("--for", dest="duration", help="With away: read working again after this long (9h, 30m, 1h30m)")
    args = parser.parse_args(argv)
    folder = config_dir(env)
    now = clock()
    try:
        if args.status is not None:
            if args.duration is not None and args.status != "away":
                raise ValueError("--for goes with away: working has no end")
            until = iso(now + parse_duration(args.duration)) if args.duration is not None else None
            folder.mkdir(parents=True, exist_ok=True)
            save_json(folder / PRESENCE, {"status": args.status, "since": iso(now), "until": until})
    except ValueError as error:
        print(f"Refused: {error}", file=sys.stderr)
        sys.exit(2)
    print(describe_presence(folder, now))


# --- the tailer -------------------------------------------------------------------------------------------------------

SECRET_NAME = re.compile(r"TOKEN|SECRET|KEY|PASS|CREDENTIAL", re.IGNORECASE)


def load_config(folder: Path) -> tuple[list[str], dict[str, str], dict | None, dict]:
    """notify.json's argv and its optional `env`, the variables set for the command (the target chat, for example
    `TELEGRAM_CHAT_ID`, which the command reads instead of its own default). A name that looks like a secret (token, key,
    secret, password, credential) is refused: the tokens stay in the command's own files, never here (decisions [G5]).
    `format` (optional, `plain` or `html`, see "Message format") and `bot` (optional, the panel bot's username without
    `@`, named in the `/verb_run@bot` commands) make up the returned style. Raises NotifyError for a missing or malformed
    file."""
    path = folder / CONFIG
    try:
        value = read_json(path)
    except FileNotFoundError:
        raise NotifyError(f"{path} is missing: write {{\"argv\": [\"<notify command>\"]}} there (RUNBOOK \"Attention notifications\")") from None
    except (OSError, ValueError) as error:
        raise NotifyError(f"{path} is unreadable: {error}") from error
    argv = value.get("argv") if isinstance(value, dict) else None
    if not isinstance(argv, list) or not argv or not all(isinstance(item, str) and item for item in argv):
        raise NotifyError(f'{path} must hold {{"argv": [<command>, <arguments>...]}}, strings only')
    env = value.get("env", {})
    if not isinstance(env, dict) or not all(isinstance(k, str) and k and isinstance(v, str) for k, v in env.items()):
        raise NotifyError(f'{path}: "env" must be an object of variable names to string values')
    secret = sorted(name for name in env if SECRET_NAME.search(name))
    if secret:
        raise NotifyError(f'{path}: "env" must not carry a secret ({", ".join(secret)}): keep tokens in the notify command\'s own files')
    topic = value.get("topic")
    if topic is not None:
        topic_argv = topic.get("argv") if isinstance(topic, dict) else None
        name = topic.get("env") if isinstance(topic, dict) else None
        rename = topic.get("rename") if isinstance(topic, dict) else None
        if not isinstance(topic_argv, list) or not topic_argv or not all(isinstance(item, str) and item for item in topic_argv) \
                or not isinstance(name, str) or not name or SECRET_NAME.search(name) \
                or (rename is not None and (not isinstance(rename, list) or not rename or not all(isinstance(item, str) and item for item in rename))):
            raise NotifyError(f'{path}: "topic" must hold {{"argv": [<command that prints a thread id>, ...], "env": "<variable the send reads>"}}'
                              ' and, optionally, "rename": [<command run with the thread id and the new name>, ...]')
    style = {"format": value.get("format", PLAIN), "bot": value.get("bot")}
    if style["format"] not in (PLAIN, HTML):
        raise NotifyError(f'{path}: "format" must be "{PLAIN}" or "{HTML}"')
    if style["bot"] is not None and not (isinstance(style["bot"], str) and BOT_NAME.fullmatch(style["bot"])):
        raise NotifyError(f'{path}: "bot" must be the bot\'s username without @ (letters, digits and _)')
    return argv, env, topic, style


def create_topic(topic: dict, name: str, env: dict[str, str] | None = None) -> int:
    """Run the topic command with the topic's name as its last argument, and notify.json's `env` set in its environment
    (the target chat: the topic is created where the messages go), and return the integer thread id it prints. Raises
    NotifyError when it is not there, exits non-zero, does not end within TIMEOUT_SECONDS or prints no integer."""
    from .worktrees import without_controller_git_config
    argv = topic["argv"]
    try:
        done = subprocess.run([*argv, name], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=TIMEOUT_SECONDS, env={**without_controller_git_config(os.environ), **(env or {})})
    except subprocess.TimeoutExpired:
        raise NotifyError(f"topic command {argv[0]} did not end within {TIMEOUT_SECONDS} s") from None
    except OSError as error:
        raise NotifyError(f"topic command {argv[0]} could not run: {error}") from error
    detail = (done.stderr or done.stdout).decode("utf-8", "replace").strip().splitlines()
    if done.returncode != 0:
        raise NotifyError(f"topic command {argv[0]} exited {done.returncode}" + (f": {detail[-1][:200]}" if detail else ""))
    try:
        return int(done.stdout.decode("utf-8", "replace").strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise NotifyError(f"topic command {argv[0]} printed no thread id" + (f": {detail[-1][:200]}" if detail else "")) from None


def rename_topic(topic: dict, thread: int, name: str, env: dict[str, str] | None = None) -> None:
    """Run the topic's `rename` command with the thread id and the new name as its last two arguments. Raises NotifyError
    when it is not there, exits non-zero or does not end within TIMEOUT_SECONDS."""
    from .worktrees import without_controller_git_config
    argv = topic["rename"]
    try:
        done = subprocess.run([*argv, str(thread), name], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=TIMEOUT_SECONDS, env={**without_controller_git_config(os.environ), **(env or {})})
    except subprocess.TimeoutExpired:
        raise NotifyError(f"rename command {argv[0]} did not end within {TIMEOUT_SECONDS} s") from None
    except OSError as error:
        raise NotifyError(f"rename command {argv[0]} could not run: {error}") from error
    if done.returncode != 0:
        detail = (done.stderr or done.stdout).decode("utf-8", "replace").strip().splitlines()
        raise NotifyError(f"rename command {argv[0]} exited {done.returncode}" + (f": {detail[-1][:200]}" if detail else ""))


def key_of(record: dict) -> list:
    """What identifies a record across passes: its run, timestamp, kind and node (the feed's own fields, never a byte span)."""
    return [record.get("run_id"), record.get("at"), record.get("kind"), record.get("node")]


def empty_state() -> dict:
    return {"version": VERSION, "offset": 0, "sent": [], "held": [], "pushed": [], "topics": {}}


def load_state(folder: Path) -> dict:
    """The saved state; a missing file is the empty state, a malformed one too (read from the start: nothing is lost)."""
    try:
        value = read_json(folder / STATE)
    except (OSError, ValueError):
        return empty_state()
    if not isinstance(value, dict):
        return empty_state()
    state = empty_state()
    if isinstance(value.get("offset"), int) and value["offset"] >= 0:
        state["offset"] = value["offset"]
    state["sent"] = [item for item in value.get("sent") or [] if isinstance(item, dict) and parse_iso(item.get("at")) is not None]
    state["held"] = [item for item in value.get("held") or [] if isinstance(item, dict) and isinstance(item.get("run_id"), str)
                     and isinstance(item.get("kind"), str) and isinstance(item.get("text"), str)]
    state["pushed"] = [key for key in value.get("pushed") or [] if isinstance(key, list) and len(key) == 4 and isinstance(key[0], str)]
    topics = value.get("topics") if isinstance(value.get("topics"), dict) else {}
    for run_id, item in topics.items():  # `{thread, name}`; a bare thread id (the first version's shape) has no name yet.
        if isinstance(run_id, str) and isinstance(item, int):
            state["topics"][run_id] = {"thread": item, "name": None}
        elif isinstance(run_id, str) and isinstance(item, dict) and isinstance(item.get("thread"), int):
            state["topics"][run_id] = {"thread": item["thread"], "name": item.get("name") if isinstance(item.get("name"), str) else None}
    return state


def read_feed(feed: Path, offset: int, out) -> tuple[list[dict], int, int]:
    """The complete records from `offset` to the end of the feed, the offset they start at (0 when the feed shrank below
    it) and the offset after the last newline read. A complete line that is not a record is reported on `out` and
    skipped; a trailing line without its newline waits for the next run. Raises NotifyError for a feed that cannot be
    read; a feed that does not exist yet is empty."""
    try:
        size = feed.stat().st_size
    except FileNotFoundError:
        return [], 0, 0
    except OSError as error:
        raise NotifyError(f"{feed} cannot be read: {error}") from error
    if size < offset:
        offset = 0
    try:
        with feed.open("rb") as handle:  # A plain open: never the feed's lock, which the controllers take to append.
            handle.seek(offset)
            data = handle.read()
    except OSError as error:
        raise NotifyError(f"{feed} cannot be read: {error}") from error
    complete = data.rfind(b"\n") + 1
    records = []
    for number, raw in enumerate(data[:complete].split(b"\n")[:-1], 1):
        record = None
        with contextlib.suppress(ValueError):
            record = json.loads(raw.decode("utf-8", "replace"))
        if (isinstance(record, dict) and isinstance(record.get("run_id"), str) and isinstance(record.get("kind"), str)
                and isinstance(record.get("text"), str)):
            records.append(record)
        elif raw.strip():
            print(f"Attention notify: skipped a line of {feed} that is not a record (line {number} after offset {offset})", file=out, flush=True)
    return records, offset, offset + complete


def cut(text: str) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= TEXT_LIMIT else text[:TEXT_LIMIT - 1] + "…"


def line_of(record: dict) -> str:
    return f"[{record['run_id']}] {record['kind']}: {cut(record['text'])}"


def fold(lines: list[str], header: str | None = None, footer: str | None = None) -> tuple[str, int]:
    """The body (the header, then as many lines as fit BODY_LIMIT, then the footer) and how many lines were left out; a
    body that leaves lines out says `… and N more in the feed` after the lines."""
    kept = list(lines)
    while kept:
        parts = [header] if header else []
        parts.extend(kept)
        left = len(lines) - len(kept)
        if left:
            parts.append(f"… and {left} more in the feed")
        if footer:
            parts.append(footer)
        body = "\n".join(parts)
        if len(body) <= BODY_LIMIT:
            return body, left
        kept.pop()
    return "\n".join(part for part in (header, footer) if part)[:BODY_LIMIT], len(lines)


def send(argv: list[str], title: str, body: str, env: dict[str, str] | None = None) -> None:
    """Run the notify command with the title and the body as its last two arguments, and notify.json's `env` set in its
    environment. Raises NotifyError when it is not there, exits non-zero or does not end within TIMEOUT_SECONDS."""
    from .worktrees import without_controller_git_config  # `python -m workflow` adds hooks-off; the command runs as written.
    try:
        done = subprocess.run([*argv, title, body], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=TIMEOUT_SECONDS, env={**without_controller_git_config(os.environ), **(env or {})})
    except subprocess.TimeoutExpired:
        raise NotifyError(f"notify command {argv[0]} did not end within {TIMEOUT_SECONDS} s") from None
    except OSError as error:
        raise NotifyError(f"notify command {argv[0]} could not run: {error}") from error
    if done.returncode != 0:
        detail = (done.stderr or done.stdout).decode("utf-8", "replace").strip().splitlines()
        raise NotifyError(f"notify command {argv[0]} exited {done.returncode}" + (f": {detail[-1][:200]}" if detail else ""))


# --- the message (format html) ---------------------------------------------------------------------------------------

COMMAND_LIMIT = 32          # Telegram recognises /commands of up to 32 characters (letters, digits, _), then @bot.
COPY_TEXT_LIMIT = 256       # Bot API: copy_text.text is 1-256 characters.
MAX_BUTTONS = 3
# Per kind: the emoji, the state named in the title line, what the operator has to do, the panel's verbs.
KIND_STYLE = {
    "question": ("❓", "question", "Answer the worker's question.", ("show", "status")),
    "pane": ("🖥", "needs you in its pane", "Attach the pane and answer there.", ("show", "status")),
    "challenge_paused": ("⏸", "challenge paused", "Edit the task, decisions or PRD and resume, or accept the challenge.",
                         ("resume", "accept", "status")),
    "review_blocked": ("🛑", "review blocked", "Read the findings; they are fixed in a follow-up run.", ("review", "status")),
    "controller_blocked": ("⛔", "controller blocked", "Inspect the evidence, then repair the lane or launch a follow-up run.",
                           ("review", "status")),
    "awaiting_approval": ("✋", "awaiting approval", "Approve or reject the candidate.", ("approve", "status")),
    "finished": ("✅", "finished", None, ("status",)),
    "sidecar": ("🔎", "sidecar finding", "Read the sidecar's finding.", ("review", "status")),
    "attack": ("🗡", "attack pass", "Read the attack report.", ("review", "status")),
    "panel": ("📣", "panel", None, ("status",)),
}
# A session record (agent-workflow's session_notify_hook.py): kind `pane` or `finished`, the text `[tab title] event: …`.
SESSION_STYLE = {
    "permission_prompt": ("🔐", "permission prompt", "Allow or deny: the prompt with its buttons is in the bot's DM, or answer in the pane.",
                          ("show", "status")),
    "elicitation_dialog": ("❓", "needs an answer", "Answer in the pane.", ("show", "status")),
    "turn ended": ("💬", "turn ended", None, ("show", "status")),
}
SESSION_OTHER = ("🔔", None, "Look at the session.", ("show", "status"))
DIGEST_EMOJI = "📬"
SESSION_TEXT = re.compile(r"(?:\[(?P<tab>[^\]]{1,80})\] )?(?P<event>[a-z_]+(?: [a-z]+)?)(?::\s*(?P<rest>.*))?$", re.S)
# A `python -m workflow …` command inside a record's text: the interpreter (any path), the module, then its arguments,
# a quoted one kept whole; a `;` ends it (the texts join two commands with `; or …`).
COMMAND = re.compile(r'(?:\S*/)?python3?(?: -I)? -m workflow(?:\.\w+)*(?:[ \t]+(?:"[^"]*"|[^\s;]+))*')
# What the texts say right before a command: dropped from the prose once the command is listed on its own.
LEAD_IN = re.compile(r"[\s:;,]*(?:then run|run|or accept it|Reattach the pane with|Status|status)?[\s:;,]*$")
# A sentence that follows a command in the same text (`…approve <bundle> --by operator. Nothing is pushed until then.`).
SENTENCE_END = re.compile(r"\.\s+(?=[A-Z])")
MARKDOWN_BOLD = re.compile(r"\*\*([^*\n]+?)\*\*")
MARKDOWN_CODE = re.compile(r"`([^`\n]+?)`")


def esc(text: str) -> str:
    """Telegram HTML: `<`, `>` and `&` escaped, quotes kept (they are text, and inside <code> they must copy as written)."""
    return html.escape(str(text), quote=False)


def cut_words(text: str, limit: int = TEXT_LIMIT) -> str:
    """`cut`, at a word boundary when one lies in the second half of the room."""
    text = " ".join(str(text).split())
    if len(text) <= limit:
        return text
    head = text[:limit - 1]
    space = head.rfind(" ")
    return (head[:space] if space > limit // 2 else head).rstrip() + "…"


def tidy(text: str, record: dict, home: str, *, prose: bool = True) -> str:
    """The home folder as `~` (bash expands it back, so a command stays runnable); in prose the run's folder as its id."""
    run_dir = record.get("run_dir")
    if prose and isinstance(run_dir, str) and run_dir and isinstance(record.get("run_id"), str):
        text = text.replace(run_dir, record["run_id"])
    if home:
        text = text.replace(home + "/", "~/")
    return text


def command_spans(text: str) -> list[tuple[int, int, str]]:
    """Where each `python -m workflow …` command starts and ends in the text, and the command; a sentence that follows
    the command is not part of it."""
    spans = []
    for match in COMMAND.finditer(text):
        command = match.group(0)
        end = SENTENCE_END.search(command)
        if end:
            command = command[:end.start()]
        command = command.rstrip(".")
        spans.append((match.start(), match.start() + len(command), command))
    return spans


def commands_of(text: str) -> list[tuple[str, str]]:
    """The `python -m workflow …` commands in the text, each with a label: its subcommand, `accept` for a resume that
    accepts the challenge, `attach` for workflow.interactive attach-one."""
    found = []
    for _, _, command in command_spans(text):
        words = command.split()
        after = words[words.index("workflow") + 1:] if "workflow" in words else words[words.index("-m") + 2:]
        label = next((word for word in after if not word.startswith("-")), "command")
        if "--accept-challenge" in words:
            label = "accept"
        elif label == "attach-one":
            label = "attach"
        found.append((label, command))
    return found


def markdown_tags(escaped: str) -> str:
    """`**bold**` and `` `code` `` of an assistant's reply as tags; the text is already escaped."""
    return MARKDOWN_CODE.sub(r"<code>\1</code>", MARKDOWN_BOLD.sub(r"<b>\1</b>", escaped))


def describe(record: dict, home: str = "") -> dict:
    """What one record shows: emoji, state, todo, verbs, the tab title (session records), its prose (HTML) and its
    commands (label, text) with the home folder as `~`."""
    kind, text = record.get("kind"), " ".join(str(record.get("text", "")).split())
    style = KIND_STYLE.get(kind, ("•", kind or "record", None, ("status",)))
    tab, session = None, False
    if isinstance(record.get("title"), str) and record["title"].strip():
        tab = " ".join(record["title"].split())
    match = SESSION_TEXT.fullmatch(text)
    if match and (match.group("event") in SESSION_STYLE or (kind == "pane" and " " not in match.group("event"))):
        session, tab = True, tab or match.group("tab")
        event = match.group("event")
        emoji, state, todo, verbs = SESSION_STYLE.get(event, SESSION_OTHER)
        style = (emoji, state or event.replace("_", " "), todo, verbs)
        text = match.group("rest") or ""
    commands = [(label, tidy(command, record, home, prose=False)) for label, command in commands_of(text)]
    spans = command_spans(text)
    prose = text
    if spans:  # The text before the first command, and the sentence after the last one when there is one.
        prose = LEAD_IN.sub("", text[:spans[0][0]])
        after = text[spans[-1][1]:].lstrip(" .;:,")
        if after[:1].isupper():
            prose = f"{prose} {after}" if prose else after
    prose = esc(cut_words(tidy(prose, record, home)))
    if session:
        prose = markdown_tags(prose).replace(" / ", "\n")
    return {"emoji": style[0], "state": style[1], "todo": style[2], "verbs": style[3], "session": session, "tab": tab, "prose": prose,
            "commands": commands}


def command_token(verb: str, run_id: str, bot: str | None) -> str:
    """`/<verb>_<run>@<bot>`: the run id in the command's own alphabet, cut from the front to Telegram's limit."""
    base = re.sub(r"[^a-z0-9]+", "_", run_id.lower()).strip("_")
    room = COMMAND_LIMIT - len(verb) - 1
    if len(base) > room:
        base = base[-room:].strip("_")
    return f"/{verb}_{base}" + (f"@{bot}" if bot else "")


def render_line(record: dict, home: str, *, with_run: bool, with_emoji: bool, with_tab: bool = True) -> str:
    """One record: emoji, the run in bold (digests), the tab title in italics (unless the title line names it), the node in
    bold, the prose."""
    shown = describe(record, home)
    parts = [shown["emoji"]] if with_emoji else []
    if with_run:
        parts.append(f"<b>{esc(record['run_id'])}</b> {esc(shown['state'])}:")
    if shown["tab"] and with_tab:
        parts.append(f"<i>{esc(shown['tab'])}</i>")
    node = record.get("node")
    if node and not shown["session"] and not with_run:
        parts.append(f"<b>{esc(node)}</b>:")
    parts.append(shown["prose"])
    return " ".join(part for part in parts if part)


def render_run(run_id: str, records: list[dict], style: dict, home: str = "") -> tuple[str, int, str | None]:
    """One run's message in HTML: the title line, one line per record, the footer (todo, commands, panel commands); the
    lines that did not fit are left out as `fold` does. Returns the body, how many lines were left out and the inline
    keyboard (copy buttons for the commands) as JSON, or None."""
    lead = next((item for item in records if item.get("kind") in IMMEDIATE), records[-1])
    shown = describe(lead, home)
    header = f"{shown['emoji']} <b>{esc(shown['tab'] if shown['session'] and shown['tab'] else run_id)} · {esc(shown['state'])}</b>"
    lines = [render_line(item, home, with_run=False, with_emoji=len(records) > 1, with_tab=not shown["session"]) for item in records]
    commands: list[tuple[str, str]] = []
    for item in records:
        for label, command in describe(item, home)["commands"]:
            if command not in [text for _, text in commands]:
                commands.append((label, command))
    footer = []
    if shown["todo"]:
        footer.append(f"👉 {esc(shown['todo'])}")
    footer.extend(f"{esc(label)}: <code>{esc(command)}</code>" for label, command in commands)
    footer.append(" ".join(command_token(verb, run_id, style.get("bot")) for verb in shown["verbs"]))
    body, left = fold(lines, header, "\n".join(footer))
    buttons = [{"text": f"📋 {label}", "copy_text": {"text": command}} for label, command in commands if len(command) <= COPY_TEXT_LIMIT]
    markup = json.dumps({"inline_keyboard": [buttons[:MAX_BUTTONS]]}, ensure_ascii=False) if buttons else None
    return body, left, markup


TOPIC_NAME_LIMIT = 120    # Telegram allows 128.


def feature_words(record: dict) -> str:
    """The run's feature in plain words: the first clause of its feature.json `name` in the run's source checkout
    (`<run dir>.source/features/<feature>/feature.json`), else the feature folder's slug as words."""
    run_dir = record.get("run_dir")
    if not isinstance(run_dir, str) or not run_dir:
        return ""
    folder = Path(run_dir)
    slug = folder.parent.name
    name = ""
    with contextlib.suppress(OSError, ValueError, AttributeError, TypeError):
        name = read_json(folder.with_name(folder.name + ".source") / "features" / slug / "feature.json").get("name", "")
    name = " ".join(str(name).split(":", 1)[0].split()) if isinstance(name, str) else ""
    if not name or len(name) > 60:
        name = slug.replace("-", " ").replace("_", " ").strip().capitalize()
    return name


def topic_name(run_id: str, records: list[dict], home: str = "") -> str:
    """What the run's or session's topic is called: the state's emoji, then the session's pane title, or the run id and
    its feature in plain words."""
    lead = next((item for item in records if item.get("kind") in IMMEDIATE), records[-1])
    shown = describe(lead, home)
    title = lead.get("title") if isinstance(lead.get("title"), str) and lead.get("title").strip() else None
    words = feature_words(lead)
    name = f"{shown['emoji']} {title}" if title else f"{shown['emoji']} {run_id}" + (f" · {words}" if words else "")
    return " ".join(name.split())[:TOPIC_NAME_LIMIT]


def render_digest(records: list[dict], home: str = "") -> tuple[str, int]:
    header = f"{DIGEST_EMOJI} <b>{len(records)} more records</b>"
    return fold([render_line(item, home, with_run=True, with_emoji=True) for item in records], header)


class Tailer:
    """One run of the command over the files in `folder`."""

    def __init__(self, folder: Path, clock=time.time, out=None, home: str | None = None):
        self.folder, self.clock, self.out = folder, clock, sys.stderr if out is None else out
        self.home = os.environ.get("HOME", "") if home is None else home  # Only a string to shorten paths with; no file of it is read.
        self.style = {"format": PLAIN, "bot": None}
        self.sent_messages = self.sent_records = 0
        self.held_records = 0
        self.warnings: list[str] = []  # A topic that could not be created: the message went without it; the pass exits 2.

    def run(self) -> None:
        now = self.clock()
        argv, env, topic, self.style = load_config(self.folder)
        state = load_state(self.folder)
        records, start, end = read_feed(self.folder / FEED, state["offset"], self.out)
        state["offset"] = start
        state["sent"] = [item for item in state["sent"] if parse_iso(item["at"]) > now - WINDOW_SECONDS]
        before = json.dumps(state, sort_keys=True)
        presence = presence_status(self.folder, now)
        messages = self.plan(records, state, presence, now)
        try:
            for message in messages:  # Stops at the first refusal: what follows waits, unlost, for the next pass.
                send(argv, TITLE, message["body"], self.style_env(message, self.thread_env(topic, state, message, env)))
                self.log(message["records"], now)
                state["sent"].append({"at": iso(now), "digest": message["digest"]})
                state["pushed"].extend(key_of(record) for record in message["records"])
                self.sent_messages += 1
                self.sent_records += len(message["records"])
                if message["digest"]:
                    state["held"] = [item for item in state["held"] if not any(item is sent for sent in message["records"])]
        except NotifyError:
            self.save(state)  # The records that went are remembered by key; the offset stays for the retry.
            raise
        state["offset"], state["pushed"] = end, []
        if json.dumps(state, sort_keys=True) != before:  # A minute with nothing new leaves the file as it was.
            self.save(state)

    def thread_env(self, topic: dict | None, state: dict, message: dict, env: dict[str, str]) -> dict[str, str]:
        """The send's environment: `env`, plus the run's topic thread id under the topic's variable when topics are
        configured and the message is one run's. The topic is created once per run, named by `topic_name` (the state's
        emoji, then the session's pane title or the run id and its feature), and its id and name kept in
        `state["topics"]`; when the name changes (another state, another pane title) the topic is renamed through the
        topic's `rename` command. A creation that fails is a warning (the message goes without a topic, into the group's
        general topic) and is tried again at the next run message; a rename that fails is a warning and is tried again
        at the next message. A digest (several runs) has no topic."""
        run_id = message["run_id"]
        if topic is None or run_id is None:
            return env
        name = topic_name(run_id, message["records"], self.home)
        known = state["topics"].get(run_id)
        if known is None:
            try:
                thread = create_topic(topic, name, env)
            except NotifyError as error:
                self.warnings.append(f"topic for {run_id} not created, sent without it: {error}")
                return env
            state["topics"][run_id] = {"thread": thread, "name": name}
        elif known.get("name") != name and topic.get("rename"):  # The state changed (its emoji) or the pane's title did.
            try:
                rename_topic(topic, known["thread"], name, env)
                known["name"] = name
            except NotifyError as error:
                self.warnings.append(f"topic for {run_id} not renamed to {name!r}: {error}")
        return {**env, topic["env"]: str(state["topics"][run_id]["thread"])}

    def style_env(self, message: dict, env: dict[str, str]) -> dict[str, str]:
        """With format html: the parse mode and, when the message has buttons, the inline keyboard, for the command."""
        if self.style["format"] != HTML:
            return env
        env = {**env, "NOTIFY_PARSE_MODE": "HTML"}
        if message.get("markup"):
            env["NOTIFY_REPLY_MARKUP"] = message["markup"]
        return env

    def plan(self, records: list[dict], state: dict, presence: str, now: float) -> list[dict]:
        """The messages of this run in order: one message per run of the new records, in the feed order of their first
        unsent record, then a digest of what is held (when one may go out). The digest goes last so that a held line the
        channel refuses blocks nothing that waits on the operator: the run messages before it went out and were logged
        before the refusal. A record already pushed by a pass a send refused, or already held, is skipped. Lines past
        the cap, or held by presence, join `state["held"]`."""
        done = {tuple(key) for key in state["pushed"]} | {tuple(key_of(item)) for item in state["held"]}
        records = [record for record in records if tuple(key_of(record)) not in done]
        held_before = list(state["held"])  # What this pass holds waits for the next pass's digest, as the RUNBOOK says.
        window = state["sent"]
        slots = CAP - len(window)
        messages = []
        groups: dict[str, list[dict]] = {}
        for record in records:
            groups.setdefault(record["run_id"], []).append(record)
        for run_id, items in groups.items():
            waiting = [item for item in items if presence == "away" and item["kind"] not in IMMEDIATE]
            self.hold(state, waiting, "away", now)
            pushed = [item for item in items if item not in waiting]
            if not pushed:
                continue
            if slots <= 0:
                self.hold(state, pushed, "cap", now)
                continue
            markup = None
            if self.style["format"] == HTML:
                body, left, markup = render_run(run_id, pushed, self.style, self.home)
            else:
                body, left = fold([line_of(item) for item in pushed])
            included = pushed[:len(pushed) - left]
            self.hold(state, pushed[len(pushed) - left:], "overflow", now)
            messages.append({"run_id": run_id, "digest": False, "body": body, "records": included, "markup": markup})
            slots -= 1
        releasable = [item for item in held_before if presence == "working" or item["kind"] in IMMEDIATE]
        if releasable and (slots > 0 or not any(item.get("digest") for item in window)):
            if self.style["format"] == HTML:
                body, left = render_digest(releasable, self.home)
            else:
                body, left = fold([line_of(item) for item in releasable], f"{len(releasable)} more records")
            included = releasable[:len(releasable) - left]
            messages.append({"run_id": None, "digest": True, "body": body, "records": included, "markup": None})
        return messages

    def hold(self, state: dict, records: list[dict], reason: str, now: float) -> None:
        """Keep the records for a later digest, each with the key that identifies it across passes."""
        known = {tuple(key_of(item)) for item in state["held"]}
        for record in records:
            key = tuple(key_of(record))
            if key in known:
                continue
            known.add(key)
            state["held"].append({"at": record.get("at"), "run_id": record["run_id"], "run_dir": record.get("run_dir"), "kind": record["kind"],
                                  "node": record.get("node"), "text": record["text"], "title": record.get("title"), "reason": reason, "held_at": iso(now)})
            self.held_records += 1

    def log(self, records: list[dict], now: float) -> None:
        with (self.folder / NOTIFIED).open("a") as handle:
            for record in records:
                handle.write(json.dumps({"at": record.get("at"), "sent_at": iso(now), "run_id": record["run_id"], "kind": record["kind"]}) + "\n")
            handle.flush()

    def save(self, state: dict) -> None:
        save_json(self.folder / STATE, state)


def attention_notify_main(argv: list[str], *, env: dict | None = None, clock=time.time) -> None:
    parser = argparse.ArgumentParser(prog="python -m workflow attention-notify", description=__doc__.split("\n\n")[0])
    parser.parse_args(argv)
    folder = config_dir(env)
    try:
        folder.mkdir(parents=True, exist_ok=True)
        with (folder / LOCK).open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print("Attention notify: another instance is running; nothing done", file=sys.stderr, flush=True)
                return
            tailer = Tailer(folder, clock)
            try:
                tailer.run()
            finally:
                if tailer.sent_messages or tailer.held_records:
                    print(f"Attention notify: sent {tailer.sent_messages} message(s) for {tailer.sent_records} record(s), "
                          f"held {tailer.held_records}", flush=True)
            if tailer.warnings:
                for warning in tailer.warnings:
                    print(f"Attention notify: {warning}", file=sys.stderr, flush=True)
                sys.exit(2)
    except NotifyError as error:
        print(f"Attention notify failed: {error}", file=sys.stderr, flush=True)
        sys.exit(2)
    except OSError as error:
        print(f"Attention notify failed: {error}", file=sys.stderr, flush=True)
        sys.exit(2)
