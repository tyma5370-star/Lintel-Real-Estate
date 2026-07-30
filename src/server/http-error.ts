/**
 * Its own module so `routes.ts` does not have to import from `index.ts`, which
 * imports `routes.ts` back. The cycle happened to work — the class is only used
 * inside handler bodies, by which time both modules are initialised — but it is
 * the kind of thing that breaks silently the moment someone uses it at module
 * scope.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
