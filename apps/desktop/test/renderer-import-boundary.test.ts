import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const nodeOnlyCoreModule =
  /\/packages\/core\/src\/(?:index|storage|store|service)\.js$/;

test("renderer source never imports Node-only core modules at runtime", async () => {
  const sourceRoot = resolve("src"),
    sources: string[] = [];
  async function collect(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (/\.tsx?$/.test(entry.name)) sources.push(path);
    }
  }
  await collect(sourceRoot);
  const violations: string[] = [];
  for (const file of sources) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly)
        continue;
      const specifier = ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : "";
      if (nodeOnlyCoreModule.test(specifier))
        violations.push(`${file}: ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});
