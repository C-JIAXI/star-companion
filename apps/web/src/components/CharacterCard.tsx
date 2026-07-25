import { CalendarDays, Lock, Settings, Sparkles, Star, Tag } from "lucide-react";
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
  favoriteLabel: string;
  unfavoriteLabel: string;
  onPlay: (id: string) => void;
  onEdit: (character: CharacterDTO) => void;
  onToggleFavorite: (character: CharacterDTO) => void;
  favoritePending?: boolean;
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
  favoriteLabel,
  unfavoriteLabel,
  onPlay,
  onEdit,
  onToggleFavorite,
  favoritePending,
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
      data-character-id={character.id}
      data-character-favorite={character.isFavorite ? "true" : "false"}
      className={`group flex flex-col overflow-hidden rounded-lg border bg-ink-900 p-0 text-sm transition-colors ${
        selectable
          ? "cursor-pointer hover:bg-ink-800"
          : "hover:bg-ink-800"
      } ${
        selected
          ? "border-ember-400/45"
          : "border-white/[0.08] hover:border-white/[0.15]"
      }`}
      onClick={selectable ? () => onSelect?.(character.id, !selected) : undefined}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden border-b border-white/[0.08] bg-ink-800">
        <img
          alt=""
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          src={src}
          loading="lazy"
        />
        {selectable ? (
          <label
            className="absolute right-2 top-2 z-10 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-white/20 bg-black/65 transition-colors hover:bg-black/80"
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
        ) : (
          <button
            aria-label={character.isFavorite ? unfavoriteLabel : favoriteLabel}
            aria-pressed={character.isFavorite}
            className={`absolute right-2 top-2 z-10 flex h-10 w-10 items-center justify-center rounded-md border backdrop-blur-sm transition-colors ${
              character.isFavorite
                ? "border-amber-300/40 bg-black/70 text-amber-300 hover:bg-black/80"
                : "border-white/20 bg-black/60 text-white/80 hover:bg-black/75 hover:text-amber-200"
            }`}
            data-character-action="favorite"
            disabled={favoritePending}
            title={character.isFavorite ? unfavoriteLabel : favoriteLabel}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite(character);
            }}
          >
            <Star size={18} fill={character.isFavorite ? "currentColor" : "none"} />
          </button>
        )}
      </div>
      <div className="min-w-0 w-full flex-1 px-4 pb-3 pt-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate text-sm font-semibold text-ink-50">{character.name}</p>
          {character.visibility === "private" ? (
            <Lock size={12} className="shrink-0 text-amber-400" />
          ) : null}
        </div>
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
                className="inline-flex max-w-full items-center gap-1 rounded border border-white/[0.08] bg-white/[0.035] px-1.5 py-0.5 text-[11px] leading-4 text-ink-300"
              >
                <Tag size={10} />
                <span className="max-w-[7rem] truncate">{tag}</span>
              </span>
            ))}
          </div>
        ) : null}
        <div className="mt-3 grid gap-1 border-t border-white/[0.06] pt-2 text-[11px] leading-4 text-ink-500">
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
      <div className="flex w-full items-center justify-center gap-2 border-t border-white/[0.06] px-3 py-3">
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
