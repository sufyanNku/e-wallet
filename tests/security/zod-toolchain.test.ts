import { realpathSync } from "node:fs";
import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
it("Hardhat legacy Zod security backport rejects oversized arrays/exact lengths/sets before parsing members", async () => {
  const require = createRequire(
      realpathSync(resolve("contracts/node_modules/hardhat/package.json")),
    ),
    common = require("zod"),
    root = dirname(require.resolve("zod/package.json")),
    module = await import(
      /* @vite-ignore */ pathToFileURL(resolve(root, "v3/index.js")).href
    );
  expect(require("zod/package.json").version).toBe("3.25.76");
  for (const { z } of [common, module]) {
    let parsed = 0;
    const element = z.preprocess((value: unknown) => {
      parsed++;
      return value;
    }, z.string());
    for (const schema of [
      z.array(element).max(2),
      z.array(element).length(2),
    ]) {
      const result = schema.safeParse(new Array(10000).fill(0));
      expect(result.success).toBe(false);
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0].code).toBe("too_big");
      expect(parsed).toBe(0);
    }
    const result = z
      .set(element)
      .max(2)
      .safeParse(new Set([1, 2, 3, 4]));
    expect(result.success).toBe(false);
    expect(result.error.issues).toHaveLength(1);
    expect(parsed).toBe(0);
    expect(z.array(z.number()).max(2).parse([1, 2])).toEqual([1, 2]);
  }
});
