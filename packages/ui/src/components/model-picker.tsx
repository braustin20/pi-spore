import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { Popover } from "radix-ui";
import { type KeyboardEvent, type ReactNode, type RefObject, useRef, useState } from "react";
import { cn } from "../cn.js";
import { control } from "./field.js";
import { Notice } from "./notice.js";

export interface PickerModel {
  provider: string;
  id: string;
  name?: string;
  tier?: string;
}

const AUTO_KEY = "spore/auto";

const keyOf = (model: PickerModel) => `${model.provider}/${model.id}`;
const textOf = (model: PickerModel) => model.name ?? model.id;
const byText = (a: PickerModel, b: PickerModel) => textOf(a).localeCompare(textOf(b));

/** The matches of a search: the suggested ones first, in their order, then the rest by name. */
function search(suggested: readonly PickerModel[], rest: readonly PickerModel[], query: string) {
  const needle = query.toLowerCase();
  const matches = (model: PickerModel) =>
    [textOf(model), model.id, model.provider].some((part) => part.toLowerCase().includes(needle));
  return [...suggested.filter(matches), ...rest.filter(matches).sort(byText)];
}

/** Suggested: spore/auto, then the tiered models low to high. Everything else goes under its provider. */
function group(models: readonly PickerModel[], tiers: readonly string[], suggest: boolean) {
  const rank = (model: PickerModel) => (model.tier ? tiers.indexOf(model.tier) : -1);
  const suggested = suggest
    ? [
        ...models.filter((model) => keyOf(model) === AUTO_KEY),
        ...models
          .filter((model) => keyOf(model) !== AUTO_KEY && rank(model) >= 0)
          .sort((a, b) => rank(a) - rank(b) || byText(a, b)),
      ]
    : [];
  const providers = new Map<string, PickerModel[]>();
  for (const model of models) {
    if (suggested.includes(model)) continue;
    providers.set(model.provider, [...(providers.get(model.provider) ?? []), model]);
  }
  const byProvider = [...providers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, list]) => ({ provider, models: list.sort(byText) }));
  return { suggested, byProvider };
}

const heading = "px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase";

function Item({
  selected,
  highlighted,
  onPick,
  children,
}: {
  selected: boolean;
  highlighted?: boolean;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      data-highlighted={highlighted || undefined}
      onClick={onPick}
      className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-raised focus-visible:bg-raised data-[highlighted]:bg-raised max-md:min-h-11"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected && <Check aria-hidden="true" className="size-4 shrink-0 text-accent-strong" />}
    </button>
  );
}

function ModelText({ model, showProvider }: { model: PickerModel; showProvider: boolean }) {
  return (
    <>
      {textOf(model)}
      {showProvider && <span className="ml-2 text-xs text-muted">{model.provider}</span>}
    </>
  );
}

function PickerBody({
  value,
  models,
  tiers,
  defaultLabel,
  tierError,
  onPick,
  searchRef,
}: {
  value: string;
  models: readonly PickerModel[];
  tiers: readonly string[];
  defaultLabel?: string | undefined;
  tierError?: string | undefined;
  onPick: (value: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [openProviders, setOpenProviders] = useState<ReadonlySet<string>>(new Set());
  const { suggested, byProvider } = group(models, tiers, !tierError);
  const matches = query
    ? search(
        suggested,
        byProvider.flatMap((each) => each.models),
        query,
      )
    : [];

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!query) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((index) => Math.max(0, Math.min(matches.length - 1, index + step)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const model = matches[highlight];
      if (model) onPick(keyOf(model));
    }
  }

  function toggle(provider: string) {
    setOpenProviders((open) => {
      const next = new Set(open);
      if (!next.delete(provider)) next.add(provider);
      return next;
    });
  }

  return (
    <>
      <input
        ref={searchRef}
        type="search"
        aria-label="Search models"
        placeholder="Search models"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        className={cn(control, "mb-1 h-8 w-full px-2.5 max-md:min-h-11")}
      />
      {query ? (
        matches.length === 0 ? (
          <p className="px-2 py-1.5 text-muted">No models match</p>
        ) : (
          matches.map((model, index) => (
            <Item
              key={keyOf(model)}
              selected={keyOf(model) === value}
              highlighted={index === highlight}
              onPick={() => onPick(keyOf(model))}
            >
              <ModelText model={model} showProvider />
            </Item>
          ))
        )
      ) : (
        <>
          {defaultLabel !== undefined && (
            <Item selected={value === ""} onPick={() => onPick("")}>
              {defaultLabel}
            </Item>
          )}
          {tierError && (
            <Notice tone="warn" className="my-1">
              {tierError}
            </Notice>
          )}
          {suggested.length > 0 && (
            <section aria-label="Suggested">
              <h3 className={heading}>Suggested</h3>
              {suggested.map((model) => (
                <Item
                  key={keyOf(model)}
                  selected={keyOf(model) === value}
                  onPick={() => onPick(keyOf(model))}
                >
                  <ModelText model={model} showProvider />
                </Item>
              ))}
            </section>
          )}
          {byProvider.length > 0 && (
            <section aria-label="By provider">
              <h3 className={heading}>By provider</h3>
              {byProvider.map(({ provider, models: list }) => {
                const open = openProviders.has(provider);
                const Icon = open ? ChevronDown : ChevronRight;
                return (
                  <div key={provider}>
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggle(provider)}
                      className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-muted outline-none hover:bg-raised focus-visible:bg-raised max-md:min-h-11"
                    >
                      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                      {provider} ({list.length})
                    </button>
                    {open && (
                      <div className="pl-4">
                        {list.map((model) => (
                          <Item
                            key={keyOf(model)}
                            selected={keyOf(model) === value}
                            onPick={() => onPick(keyOf(model))}
                          >
                            <ModelText model={model} showProvider={false} />
                          </Item>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )}
        </>
      )}
    </>
  );
}

/**
 * A searchable model list in a popover. It replaces long native selects: a search box, an optional default item,
 * a Suggested group by tier, and the rest folded under each provider. It calls onChange only when the user picks.
 */
export function ModelPicker({
  value,
  label,
  models,
  tiers,
  onChange,
  onOpen,
  disabled,
  defaultLabel,
  tierError,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  label: string;
  models: readonly PickerModel[];
  tiers: readonly string[];
  onChange: (value: string) => void;
  onOpen?: (() => void) | undefined;
  disabled?: boolean | undefined;
  defaultLabel?: string | undefined;
  tierError?: string | undefined;
  className?: string | undefined;
  "aria-label": string;
}) {
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen?.();
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(
            control,
            "relative inline-flex h-8 items-center pr-7 pl-2.5 text-left max-md:min-h-11",
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <ChevronDown
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted"
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchRef.current?.focus();
          }}
          className="z-50 max-h-[60vh] min-w-[max(16rem,var(--radix-popover-trigger-width))] max-w-[90vw] overflow-y-auto rounded-xl border border-line bg-panel p-1 text-sm text-fg"
        >
          <PickerBody
            value={value}
            models={models}
            tiers={tiers}
            defaultLabel={defaultLabel}
            tierError={tierError}
            onPick={(picked) => {
              setOpen(false);
              onChange(picked);
            }}
            searchRef={searchRef}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
