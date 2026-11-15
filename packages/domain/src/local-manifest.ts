import { z } from "zod";
export const localManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    seedVersion: z.literal(1),
    runId: z.string().uuid(),
    createdAt: z.iso.datetime(),
    mode: z.literal("local"),
    warning: z.literal(
      "Public insecure local fixtures. Test assets have no monetary value.",
    ),
    nodes: z.array(
      z.object({
        networkId: z.string(),
        identity: z.string(),
        bootEpoch: z.string().nullable(),
      }),
    ),
    toolVersions: z.record(z.string(), z.string()),
    publicIdentities: z.record(z.string(), z.unknown()),
    deployments: z.array(z.unknown()),
    tokens: z.array(z.unknown()),
    scenarios: z.array(
      z.object({
        id: z.string(),
        networkId: z.string(),
        identifier: z.string(),
        state: z.string(),
        fee: z.string().nullable(),
        evidenceStatus: z.enum(["live", "pruned"]),
      }),
    ),
    openingAmounts: z.record(z.string(), z.unknown()),
    finalAmounts: z.record(z.string(), z.unknown()),
    syntheticMicroUsdRates: z.record(z.string(), z.string().regex(/^[0-9]+$/)),
    assertions: z.object({
      state: z.literal("passed"),
      evidence: z.array(z.string()),
    }),
  })
  .strict()
  .superRefine((value, ctx) => {
    function walk(v: unknown) {
      if (!v || typeof v !== "object") return;
      for (const [key, child] of Object.entries(v)) {
        if (
          /^(mnemonic|phrase|privateKey|private_key|password|entropyHex|cookie|csrfToken|signedBytesBase64|signedTransaction|secret)$/i.test(
            key,
          )
        )
          ctx.addIssue({
            code: "custom",
            message: "Private fields cannot appear in a public seed manifest.",
          });
        walk(child);
      }
    }
    walk(value);
  });
export type LocalManifest = z.infer<typeof localManifestSchema>;
