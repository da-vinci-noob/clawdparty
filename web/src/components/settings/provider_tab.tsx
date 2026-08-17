import { type FC, type FormEvent, useState } from "react";
import { useCurrentParticipant } from "../../hooks/use_current_participant";
import { useModels } from "../../hooks/use_models";
import { useSession } from "../../hooks/use_session";
import { useAwsProfiles, useSaveSessionDefaults } from "../../hooks/use_session_defaults";

// Settings → Provider: what a run starts with when the composer is left alone.
//
// These are DEFAULTS, not locks — the composer's per-run picker is the point of having a picker, and
// it still wins. What this removes is re-picking the same model on every run.
//
// Two things are deliberate:
//   * The lists come from the SAME discovery the composer uses, so the two can never disagree about
//     what exists. A hand-kept second list is how a picker ends up offering a model run start refuses.
//   * The AWS profile decides WHOSE ACCOUNT PAYS , so it is owner-only and labelled as such.
//     Profile NAMES only — no credential value is read anywhere in this path.

const NO_DEFAULT = "";

export const ProviderTab: FC<{ sessionId: string }> = ({ sessionId }) => {
  const session = useSession(sessionId);
  const models = useModels();
  const profiles = useAwsProfiles();
  const { can } = useCurrentParticipant();
  const { save, busy, error, saved } = useSaveSessionDefaults(sessionId);
  const mayWrite = can("manage_session");

  // Seeded from the session once it loads; `??` rather than `||` so a stored empty string is kept.
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [profile, setProfile] = useState<string | null>(null);

  if (session === null) {
    return (
      <p data-testid="provider-unavailable" className="text-[12px] text-[#6b726b]">
        This session’s settings could not be read.
      </p>
    );
  }

  const chosenProvider = provider ?? session.default_provider ?? NO_DEFAULT;
  const chosenModel = model ?? session.default_model ?? NO_DEFAULT;
  const chosenProfile = profile ?? session.aws_profile ?? NO_DEFAULT;

  const providers = [...new Map(models.map((m) => [m.provider, m.providerLabel])).entries()];
  // Models are filtered BY PROVIDER, because a model id only means something relative to the
  // provider serving it — and the server refuses a mismatched pair, so offering one would be a
  // guaranteed 422.
  const providerModels = models.filter((m) => m.provider === chosenProvider);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      await save({
        default_provider: chosenProvider,
        default_model: chosenModel,
        aws_profile: chosenProfile,
      });
    } catch {
      // Surfaced by `error` from the hook.
    }
  };

  return (
    <form onSubmit={submit} data-testid="provider-form" className="space-y-4">
      <p className="text-[12px] text-[#6b726b]">
        Defaults for <span className="text-[#aeb4ae]">this session</span>. The composer can still
        pick something else for a single run.
      </p>

      <label className="block space-y-1">
        <span className="text-[11px] uppercase tracking-[0.5px] text-[#565d58]">Provider</span>
        <select
          aria-label="Default provider"
          data-testid="default-provider"
          value={chosenProvider}
          disabled={!mayWrite}
          onChange={(e) => {
            setProvider(e.target.value);
            // Clear the model: keeping one from the previous provider is exactly the mismatch the
            // server rejects, and it would look like the form saved something it did not.
            setModel(NO_DEFAULT);
          }}
          className="w-full rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[11px] py-[7px] font-mono text-[12px] text-[#cdd2cd] disabled:opacity-60"
        >
          <option value={NO_DEFAULT}>No default — resolve at run start</option>
          {providers.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-1">
        <span className="text-[11px] uppercase tracking-[0.5px] text-[#565d58]">Model</span>
        <select
          aria-label="Default model"
          data-testid="default-model"
          value={chosenModel}
          disabled={!mayWrite || chosenProvider === NO_DEFAULT}
          onChange={(e) => setModel(e.target.value)}
          className="w-full rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[11px] py-[7px] font-mono text-[12px] text-[#cdd2cd] disabled:opacity-60"
        >
          <option value={NO_DEFAULT}>No default — resolve at run start</option>
          {providerModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {chosenProvider === NO_DEFAULT && (
          <span className="block text-[11px] text-[#6b726b]">Pick a provider first.</span>
        )}
      </label>

      <label className="block space-y-1">
        <span className="text-[11px] uppercase tracking-[0.5px] text-[#565d58]">AWS profile</span>
        <select
          aria-label="AWS profile"
          data-testid="aws-profile"
          value={chosenProfile}
          disabled={!mayWrite}
          onChange={(e) => setProfile(e.target.value)}
          className="w-full rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[11px] py-[7px] font-mono text-[12px] text-[#cdd2cd] disabled:opacity-60"
        >
          <option value={NO_DEFAULT}>Host default</option>
          {profiles.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        {/* The consequence, stated where the choice is made. */}
        <span data-testid="aws-profile-note" className="block text-[11px] text-[#c9a227]">
          Decides which AWS account a Bedrock run bills. Owner-only.
        </span>
      </label>

      {mayWrite ? (
        <button
          type="submit"
          data-testid="provider-save"
          disabled={busy}
          className="rounded-[9px] bg-[#3b9dff] px-[13px] py-[7px] font-mono text-[12px] font-semibold text-[#04101f] disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save defaults"}
        </button>
      ) : (
        <p data-testid="provider-read-only" className="text-[11px] text-[#6b726b]">
          You can see this session’s defaults; changing them is the owner’s.
        </p>
      )}

      {error && (
        <p data-testid="provider-error" className="text-[12px] text-[#f0a8a8]">
          {error}
        </p>
      )}
      {saved && !error && (
        <p data-testid="provider-saved" className="text-[12px] text-[#7cd992]">
          Saved — the next run starts with these.
        </p>
      )}
    </form>
  );
};
