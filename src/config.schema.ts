import { defineConfigSchema, z } from "jsr:@pons/sdk@^0.3/config";

export default defineConfigSchema(
  z.object({
    host: z.string().default("127.0.0.1"),
    httpPort: z.number().int().min(1).max(65535).default(18790),
    auth: z
      .object({
        enabled: z.boolean().default(true),
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
