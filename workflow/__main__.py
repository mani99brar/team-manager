"""`python -m workflow` exposes the complete operator-driven pipeline CLI, plus `launch`, `init`, `resume` and `answer`."""
import sys

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "launch":
        from .launch import main
        main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "init":
        from .scaffold import main
        main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "resume":
        from .guardrails import resume_main
        resume_main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "answer":
        from .guardrails import answer_main
        answer_main(sys.argv[2:])
    else:
        from .pipeline import main
        main()
