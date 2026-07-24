/**
 * Node resolution hook: lets the check scripts import the app's own TypeScript
 * modules using the same extensionless specifiers the bundler uses, so the
 * tests exercise the exact source that ships rather than a copy.
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
    for (const ext of [".ts", "/index.ts"]) {
      try {
        return await next(specifier + ext, context);
      } catch {
        /* try the next candidate */
      }
    }
  }
  return next(specifier, context);
}
