import { CalendarDays, Lock, Settings, Sparkles, Tag } from "lucide-react";
import type { CharacterDTO } from "../types";
import { usePlaceholderSrc } from "../placeholderImages";
import { Button } from "./ui";

interface CharacterCardProps {
  character: CharacterDTO;
  noDescriptionLabel: string;
  privateSummaryLabel: string;
  createdAtLabel: string;
  updatedAtLabel: string;
  locale: string;
  playLabel: string;
  editLabel: string;
  onPlay: (id: string) => void;
  onEdit: (character: CharacterDTO) => void;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (id: string, selected: boolean) => void;
}

export function CharacterCard({
  character,
  noDescriptionLabel,
  privateSummaryLabel,
  createdAtLabel,
  updatedAtLabel,
  locale,
  playLabel,
  editLabel,
  onPlay,
  onEdit,
  selectable,
  selected,
  onSelect
}: CharacterCardProps) {
  const src = usePlaceholderSrc(character.avatar, character.id);
  const formatDate = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }

    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(date);
  };

  return (
    <div
      className={`group flex flex-col overflow-hidden rounded-xl border bg-white/5 p-0 text-sm transition-all duration-200 active:bg-white/[0.08] ${
        selectable
          ? "cursor-pointer hover:bg-white/10"
          : "hover:bg-white/10"
      } ${
        selected
          ? "border-ember-500/40 shadow-lg shadow-ember-500/10"
          : "border-white/5 hover:border-white/10"
      }`}
      onClick={selectable ? () => onSelect?.(character.id, !selected) : undefined}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-ink-800 ring-1 ring-white/5 transition-all duration-200 group-hover:ring-ember-500/30">
        <img
          alt=""
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          src={src}
          loading="lazy"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
        <p className="absolute bottom-2 left-3 right-3 truncate text-sm font-semibold text-white drop-shadow-md">
          {character.name}
          {character.visibility === "private" ? (
            <Lock size={11} className="ml-1.5 inline-block shrink-0 text-amber-400" />
          ) : null}
        </p>
        {selectable ? (
          <label
            className="absolute right-2 top-2 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-white/20 bg-black/40 backdrop-blur-sm transition-colors hover:bg-black/60"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              checked={selected ?? false}
              type="checkbox"
              className="sr-only"
              onChange={(event) => onSelect?.(character.id, event.target.checked)}
            />
            {selected ? (
              <svg className="h-4 w-4 text-ember-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : null}
          </label>
        ) : null}
      </div>
      <div className="min-w-0 w-full flex-1 px-4 pb-1 pt-3">
        <p className="line-clamp-2 text-xs leading-5 text-slate-400">
          {character.visibility === "private" && !character.canViewPrompt
            ? privateSummaryLabel
            : character.description || noDescriptionLabel}
        </p>
        {character.tags.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {character.tags.slice(0, 4).map((tag) => (
              <span
                key={tag}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[11px] leading-4 text-slate-300"
              >
                <Tag size={10} />
                <span className="max-w-[7rem] truncate">{tag}</span>
              </span>
            ))}
          </div>
        ) : null}
        <div className="mt-2 grid gap-1 text-[11px] leading-4 text-slate-500">
          <span className="inline-flex min-w-0 items-center gap-1">
            <CalendarDays size={11} />
            <span className="shrink-0">{createdAtLabel}</span>
            <span className="truncate">{formatDate(character.createdAt)}</span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-1">
            <CalendarDays size={11} />
            <span className="shrink-0">{updatedAtLabel}</span>
            <span className="truncate">{formatDate(character.updatedAt)}</span>
          </span>
        </div>
      </div>
      <div className="flex w-full items-center justify-center gap-2 px-3 pb-3 pt-1">
        <Button
          className="!min-h-[32px] !h-8 flex-1 !px-2 text-xs"
          onClick={(event) => {
            event.stopPropagation();
            onPlay(character.id);
          }}
        >
          <Sparkles size={12} />
          {playLabel}
        </Button>
        <Button
          className="!min-h-[32px] !h-8 flex-1 !px-2 text-xs"
          variant="secondary"
          onClick={(event) => {
            event.stopPropagation();
            onEdit(character);
          }}
        >
          <Settings size={12} />
          {editLabel}
        </Button>
      </div>
    </div>
  );
}
