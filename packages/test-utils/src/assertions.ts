/**
 * Type constraint for Error constructors
 */
type ErrorConstructor<T extends Error> = new (...args: unknown[]) => T;

/**
 * Asserts that a function throws an error of a specific type
 * @param fn - Function that should throw an error
 * @param ErrorClass - Expected error constructor
 * @param validate - Optional validation function to check error properties
 * @returns The thrown error if it matches expectations
 * @throws If the function doesn't throw or throws wrong error type
 */
export async function expectToThrow<T extends Error>(
  fn: () => unknown | Promise<unknown>,
  ErrorClass: ErrorConstructor<T>,
  validate?: (error: T) => void
): Promise<T> {
  let thrownError: unknown;
  let didThrow = false;

  try {
    const result = fn();
    if (result instanceof Promise) {
      await result;
    }
  } catch (error) {
    didThrow = true;
    thrownError = error;
  }

  if (!didThrow) {
    throw new Error(
      `Expected function to throw ${ErrorClass.name}, but it did not throw`
    );
  }

  if (!(thrownError instanceof ErrorClass)) {
    const actualType =
      thrownError instanceof Error
        ? thrownError.constructor.name
        : typeof thrownError;
    throw new Error(
      `Expected error to be instance of ${ErrorClass.name}, but got ${actualType}`
    );
  }

  if (validate) {
    validate(thrownError);
  }

  return thrownError;
}
