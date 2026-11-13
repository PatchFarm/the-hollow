// Writes schema/hollow.schema.json from the zod schema. Run with `npm run schema`.
// A test fails if the checked-in file drifts from the source.
import { mkdirSync, writeFileSync } from "node:fs";
import { hollowJsonSchema } from "../dist/config/schema.js";

const out = new URL("../schema/hollow.schema.json", import.meta.url);
mkdirSync(new URL("../schema/", import.meta.url), { recursive: true });
writeFileSync(out, `${JSON.stringify(hollowJsonSchema(), null, 2)}\n`);
console.log("Wrote schema/hollow.schema.json");
