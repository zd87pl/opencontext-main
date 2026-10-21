import { expect } from 'vitest';
import { OpenContextError, type SDKError } from '../src/types.js';

/**
 * Assert that a promise rejects with an OpenContextError carrying `code`,
 * and return the error for further checks.
 */
export async function expectCode(promise: Promise<unknown>, code: SDKError): Promise<OpenContextError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(OpenContextError);
  expect((error as OpenContextError).code).toBe(code);
  return error as OpenContextError;
}
