// One-off static check of the SQL text used by src/store/mysql*.ts (not part of the build).
// Parses each statement with the MySQL dialect so a typo is caught without a running server.
import sqlParser from "node-sql-parser"
import { readFileSync } from "node:fs"

const { Parser } = sqlParser
const parser = new Parser()
const source = readFileSync(new URL("../src/store/mysql.ts", import.meta.url), "utf8")
  + "\n"
  + readFileSync(new URL("../src/store/mysql-stores.ts", import.meta.url), "utf8")

const statements = []
for (const match of source.matchAll(/`([^`]*)`/g)) {
  for (const part of match[1].split(/;\s*\n/)) {
    const text = part.replace(/\$\{placeholders\}/g, "(?,?,?,?,?,?,?,?)").replace(/\$\{[^}]*\}/g, "?").replace(/\s+/g, " ").trim()
    if (/^(CREATE|INSERT|SELECT|UPDATE|DELETE)\b/i.test(text)) statements.push(text)
  }
}

let failed = 0
for (const statement of statements) {
  try { parser.astify(statement, { database: "MySQL" }) }
  catch (error) {
    failed++
    console.error(`FAIL ${statement.slice(0, 140)}\n     ${String(error.message).split("\n")[0]}`)
  }
}
console.log(`${statements.length} statements checked, ${failed} failed`)
process.exit(failed ? 1 : 0)
