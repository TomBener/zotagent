export function emitOk(data: unknown, meta: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify(
      {
        ok: true,
        data,
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
      },
      null,
      2,
    ),
  );
  process.exitCode = 0;
}

export function emitError(
  code: string,
  message: string,
  details?: unknown,
  meta: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify(
      {
        ok: false,
        error: {
          code,
          message,
          ...(details !== undefined ? { details } : {}),
        },
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
