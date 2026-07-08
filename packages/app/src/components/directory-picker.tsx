import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ServerConnection } from "@/context/server"
import { DialogSelectDirectory } from "./dialog-select-directory"

type DirectoryPickerInput = {
  server: ServerConnection.Any
  title?: string
  multiple?: boolean
  onSelect: (result: string | string[] | null) => void
}

export function useDirectoryPicker() {
  const dialog = useDialog()

  return (input: DirectoryPickerInput) => {
    dialog.show(
      () => <DialogSelectDirectory {...input} />,
      () => input.onSelect(null),
    )
  }
}
