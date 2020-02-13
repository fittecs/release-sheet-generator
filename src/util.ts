/**
 * Roughly check if a value is non-empty.
 * If that is so, then the value is returned without any processing; otherwise the function throws an error.
 *
 * @param value any value
 */
export function getNonEmptyOrThrow<T>(value: T | undefined | null): T {
  if (value) {
    return value;
  } else {
    throw new Error('The value must be specified non-empty value.');
  }
}
