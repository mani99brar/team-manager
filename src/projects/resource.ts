/** One read-only resource's state; a type with no React import so pure modules and their unit tests can use it. */
export type Resource<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: unknown }
