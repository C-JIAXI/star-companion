import { Lock, Settings, Sparkles } from "lucide-react";
import type { CharacterDTO } from "../types";
import { usePlaceholderSrc } from "../placeholderImages";
import { Button } from "./ui";

interface CharacterCardProps {
  character: CharacterDTO;
  noDescriptionLabel: string;
  privateSummaryLabel: string;
  playLabel: string;
  editLabel: string;
  onPlay: (id: string) => void;
  onEdit: (character: CharacterDTO) => void;
}

export function CharacterCard({
  character,
  noDescriptionLabel,
  privateSummaryLabel,
  playLabel,
  editLabel,
  onPlay,
  onEdit
}: CharacterCardProps) {
  const src = usePlaceholderSrc(character.avatar, character.id);

  return (
    <div
      className="group overflow-hidden rounded-xl border border-white/5 bg-white/5 p-0 text-sm transition-all duration-200 hover:border-white/10 hover:bg-white/10"
    >
      <div className="relative aspect-video w-full overflow-hidden bg-ink-800 ring-1 ring-white/5 transition-all duration-200 group-hover:ring-ember-500/30">
        <img
          alt=""
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          src={src}
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
        <p className="absolute bottom-2 left-3 right-3 truncate text-sm font-semibold text-white drop-shadow-md">
          {character.name}
          {character.visibility === "private" ? (
            <Lock size={11} className="ml-1.5 inline-block shrink-0 text-amber-400" />
          ) : null}
        </p>
      </div>
      <div className="min-w-0 w-full p-4">
        <p className="line-clamp-2 text-xs leading-5 text-slate-400">
          {character.visibility === "private" && !character.canViewPrompt
            ? privateSummaryLabel
            : character.description || noDescriptionLabel}
        </p>
      </div>
      <div className="flex w-full items-center justify-center gap-2 px-4 pb-4 pt-1">
        <Button
          className="!min-h-[32px] !h-8 flex-1 !px-3 text-xs"
          onClick={(event) => {
            event.stopPropagation();
            onPlay(character.id);
          }}
        >
          <Sparkles size={14} />
          {playLabel}
        </Button>
        <Button
          className="!min-h-[32px] !h-8 flex-1 !px-3 text-xs"
          variant="secondary"
          onClick={(event) => {
            event.stopPropagation();
            onEdit(character);
          }}
        >
          <Settings size={14} />
          {editLabel}
        </Button>
      </div>
    </div>
  );
}
