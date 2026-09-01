/**
 * How a return's status and reason are said to a customer.
 *
 * Its own module because two screens need it and a component file that also
 * exports constants breaks fast refresh. Every key here is a value the server
 * sends; anything it sends that is missing falls back to the raw string rather
 * than to a wrong guess.
 */

/** The server's vocabulary, said the way a customer would say it. */
export const RETURN_STATUS = {
  requested: { label: 'Requested', tone: 'warn' },
  approved: { label: 'Approved', tone: 'good' },
  in_transit: { label: 'On its way back', tone: 'good' },
  received: { label: 'Received', tone: 'good' },
  completed: { label: 'Complete', tone: 'good' },
  rejected: { label: 'Declined', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

export const RETURN_REASONS = {
  damaged: 'It arrived damaged',
  wrong_item: 'The wrong thing arrived',
  not_as_described: 'It is not as described',
  no_longer_wanted: 'I no longer want it',
  arrived_late: 'It arrived too late',
  other: 'Something else',
}
