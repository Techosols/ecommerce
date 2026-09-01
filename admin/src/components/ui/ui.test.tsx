import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/render'
import { Button } from './Button'
import { ConfirmDialog } from './ConfirmDialog'
import { DropdownItem, DropdownMenu } from './DropdownMenu'
import { Field } from './Field'
import { Input } from './Input'
import { Modal } from './Modal'
import { Pagination } from './Pagination'
import { DataTable, type Column } from './Table'
import { EmptyState } from '@/components/states/EmptyState'

/**
 * The design system's behavioural promises.
 *
 * These test what the components guarantee to every feature built on them —
 * accessible wiring, focus handling, and the fact that the table and paginator
 * never invent numbers — rather than their visual details.
 */

describe('Button', () => {
  it('blocks interaction and announces itself while loading', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <Button isLoading onClick={onClick}>
        Save
      </Button>,
    )

    const button = screen.getByRole('button', { name: /save/i })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')

    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('Field', () => {
  it('wires the label, hint and error to the control', () => {
    renderWithProviders(
      <Field label="Order note" hint="Visible to staff only">
        <Input />
      </Field>,
    )

    const input = screen.getByLabelText('Order note')
    expect(input).toHaveAccessibleDescription('Visible to staff only')
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('marks the control invalid and describes it with the error', () => {
    renderWithProviders(
      <Field label="Email address" error="That address is already in use.">
        <Input />
      </Field>,
    )

    const input = screen.getByLabelText('Email address')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('That address is already in use.')
  })
})

describe('Modal', () => {
  it('renders nothing when closed', () => {
    renderWithProviders(
      <Modal isOpen={false} onClose={vi.fn()} title="Refund order">
        body
      </Modal>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes on Escape when dismissible', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <Modal isOpen onClose={onClose} title="Refund order">
        body
      </Modal>,
    )

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('ignores Escape when the work must not be abandoned', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <Modal isOpen onClose={onClose} title="Processing refund" dismissible={false}>
        body
      </Modal>,
    )

    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('ConfirmDialog', () => {
  it('separates cancelling from confirming', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const user = userEvent.setup()

    renderWithProviders(
      <ConfirmDialog
        isOpen
        onCancel={onCancel}
        onConfirm={onConfirm}
        title="Cancel order 1042?"
        confirmLabel="Cancel order"
        tone="danger"
      >
        Stock will be returned to the shelf.
      </ConfirmDialog>,
    )

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Cancel order' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})

describe('DropdownMenu', () => {
  it('opens, selects and closes, returning focus to the trigger', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()

    renderWithProviders(
      <DropdownMenu
        trigger={({ ref, ...props }) => (
          <button ref={ref} type="button" {...props}>
            Actions
          </button>
        )}
      >
        <DropdownItem onSelect={onSelect}>Confirm order</DropdownItem>
      </DropdownMenu>,
    )

    const trigger = screen.getByRole('button', { name: 'Actions' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    await user.click(screen.getByRole('menuitem', { name: 'Confirm order' }))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})

interface Row {
  id: string
  reference: string
}

const columns: Array<Column<Row>> = [
  { id: 'reference', header: 'Reference', cell: (row) => row.reference },
]

describe('DataTable', () => {
  it('shows the empty state instead of an empty body', () => {
    renderWithProviders(
      <DataTable
        columns={columns}
        rows={[]}
        getRowId={(row) => row.id}
        emptyState={<EmptyState title="No orders match these filters" />}
      />,
    )

    expect(screen.getByText('No orders match these filters')).toBeInTheDocument()
  })

  it('renders skeleton rows while loading, and no empty state', () => {
    renderWithProviders(
      <DataTable
        columns={columns}
        rows={[]}
        isLoading
        skeletonRows={3}
        getRowId={(row) => row.id}
        emptyState={<EmptyState title="No orders yet" />}
      />,
    )

    expect(screen.queryByText('No orders yet')).not.toBeInTheDocument()
    // One header row plus the skeletons.
    expect(screen.getAllByRole('row')).toHaveLength(4)
  })

  it('renders one row per record', () => {
    renderWithProviders(
      <DataTable
        columns={columns}
        rows={[
          { id: '1', reference: 'ORD-1001' },
          { id: '2', reference: 'ORD-1002' },
        ]}
        getRowId={(row) => row.id}
      />,
    )

    const table = screen.getByRole('table')
    expect(within(table).getByText('ORD-1001')).toBeInTheDocument()
    expect(within(table).getByText('ORD-1002')).toBeInTheDocument()
  })
})

describe('Pagination', () => {
  it("reports the server's counts and disables the edges", async () => {
    const onPageChange = vi.fn()
    const user = userEvent.setup()

    renderWithProviders(
      <Pagination
        pagination={{ page: 1, limit: 20, total: 45, totalPages: 3, hasNext: true, hasPrev: false }}
        onPageChange={onPageChange}
      />,
    )

    expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Next page' }))
    expect(onPageChange).toHaveBeenCalledWith(2)
  })
})
