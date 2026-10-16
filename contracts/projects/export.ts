import { writeFileSync } from 'node:fs'
import { z } from 'zod'
import { schemas } from './v1.js'
import { dispatchSchemas } from './dispatch.js'
import { githubSchemas } from './github.js'

for (const [name, schema] of Object.entries({ ...schemas, ...dispatchSchemas, ...githubSchemas })) {
  writeFileSync(new URL(`./${name}.schema.json`, import.meta.url), `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`)
}
