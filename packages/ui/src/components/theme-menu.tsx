import { Check, Palette } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { setTheme, THEMES, useTheme } from "../themes.js";
import { Button } from "./button.js";

/** Four swatches of a theme. They sit inside the theme's own data-theme scope, so they show its real colors. */
function Swatches({ id }: { id: string }) {
  return (
    <span
      data-theme={id}
      aria-hidden="true"
      className="flex shrink-0 overflow-hidden rounded-md border border-line bg-bg"
    >
      <span className="size-4 bg-bg" />
      <span className="size-4 bg-panel" />
      <span className="size-4 bg-fg" />
      <span className="size-4 bg-accent" />
    </span>
  );
}

/** Lists the themes with a color preview. A choice applies at once and is remembered. */
export function ThemeMenu() {
  const current = useTheme();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label="Theme">
          <Palette />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-56 rounded-xl border border-line bg-panel p-1 text-sm text-fg"
        >
          <DropdownMenu.Label className="px-2 py-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">
            Theme
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={current} onValueChange={setTheme}>
            {THEMES.map((theme) => (
              <DropdownMenu.RadioItem
                key={theme.id}
                value={theme.id}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none data-[highlighted]:bg-raised"
              >
                <Swatches id={theme.id} />
                <span className="flex-1">{theme.name}</span>
                <DropdownMenu.ItemIndicator>
                  <Check aria-hidden="true" className="size-4 text-accent-strong" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
