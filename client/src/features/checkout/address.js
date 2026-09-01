/**
 * Address shapes and checks, kept apart from the form.
 *
 * Pure functions beside a component break fast refresh, and these are wanted
 * by the checkout page as well as by the fields themselves.
 */

/** A blank address, in the shape the server's schema expects. */
export function emptyAddress() {
  return {
    firstName: '',
    lastName: '',
    company: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    countryCode: '',
  }
}

/**
 * What the API takes: blanks become `null`, not empty strings.
 *
 * The server's schema accepts null for the optional parts and would reject a
 * bare `""` on some of them. More to the point, an empty string recorded as an
 * address line is a line that prints on a label.
 */
export function toAddressPayload(address, phone) {
  const blankToNull = (v) => {
    const trimmed = v.trim()
    return trimmed === '' ? null : trimmed
  }
  return {
    firstName: address.firstName.trim(),
    lastName: address.lastName.trim(),
    company: blankToNull(address.company),
    line1: address.line1.trim(),
    line2: blankToNull(address.line2),
    city: address.city.trim(),
    region: blankToNull(address.region),
    postalCode: blankToNull(address.postalCode),
    countryCode: address.countryCode.trim().toUpperCase(),
    phone: phone ? blankToNull(phone) : null,
  }
}

/**
 * The fields a person must fill in before the order can be placed.
 *
 * Checked here only so the shopper is told at the field rather than by a 422
 * after pressing the button. The server checks the same things and its answer
 * is the one that counts.
 */
export function validateAddress(address) {
  const errors = {}
  if (!address.firstName.trim()) errors.firstName = 'Required.'
  if (!address.lastName.trim()) errors.lastName = 'Required.'
  if (!address.line1.trim()) errors.line1 = 'Required.'
  if (!address.city.trim()) errors.city = 'Required.'
  if (!/^[A-Za-z]{2}$/.test(address.countryCode.trim())) {
    errors.countryCode = 'Two letters, e.g. GB.'
  }
  return errors
}
