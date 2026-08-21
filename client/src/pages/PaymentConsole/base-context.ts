import { bitable } from '@lark-base-open/js-sdk'

export type BaseContext = {
  embedded: boolean
  tableId?: string
  viewId?: string
}

export type SelectedRecordContext = BaseContext & {
  recordIds: string[]
}

export async function resolveBaseContext(): Promise<BaseContext> {
  try {
    const selection = await Promise.race([
      bitable.base.getSelection(),
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error('Base host unavailable')), 2000)
      }),
    ])
    const table = selection.tableId ? null : await bitable.base.getActiveTable()
    const view = selection.viewId || !table ? null : await table.getActiveView()
    return {
      embedded: true,
      tableId: selection.tableId ?? table?.id ?? undefined,
      viewId: selection.viewId ?? view?.id ?? undefined,
    }
  } catch {
    return { embedded: false }
  }
}

export async function resolveSelectedRecordContext(): Promise<SelectedRecordContext> {
  try {
    const selection = await bitable.base.getSelection()
    const table = await bitable.base.getActiveTable()
    const view = await table.getActiveView()
    const selectedRecordView = view as { getSelectedRecordIdList?: () => Promise<string[]> }
    const selected = typeof selectedRecordView.getSelectedRecordIdList === 'function'
      ? await selectedRecordView.getSelectedRecordIdList()
      : []
    const recordIds = selected.length
      ? selected
      : selection.recordId
        ? [selection.recordId]
        : []
    return {
      embedded: true,
      tableId: selection.tableId ?? table.id ?? undefined,
      viewId: selection.viewId ?? view.id ?? undefined,
      recordIds,
    }
  } catch {
    return { embedded: false, recordIds: [] }
  }
}

export async function subscribeToActiveTableChanges(callback: () => void): Promise<() => void> {
  const table = await bitable.base.getActiveTable()
  return table.onRecordModify(() => callback())
}
