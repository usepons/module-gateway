import { defineConfigSchema, z } from "jsr:@pons/sdk@^0.2/config";

export default defineConfigSchema(
  z.object({
    host: z.string().default("0.0.0.0"),
    httpPort: z.number().int().min(1).max(65535).default(18790),
    auth: z
      .object({
        enabled: z.boolean().default(false),
        tokens: z.array(z.string()).default([]),
      })
      .optional()
      .default({}),
  }),
  {
    description: "HTTP gateway configuration",
    labels: {
      host: "Bind Address",
      httpPort: "HTTP Port",
      auth: "Authentication",
    },
  }
);
