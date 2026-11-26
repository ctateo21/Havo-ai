import { windAnswersSchema, type WindAnswers } from "@shared/wind-mitigation";

/** Typed fields wait this long after the last keystroke; discrete choices
 * (selects, toggles, radio answers) save immediately. */
export const TYPED_ANSWER_DEBOUNCE_MS = 450;

/** Saved wind answers for one property, validated. Report values are kept
 * (they are the user's confirmed transcription); no file content is stored. */
export function restoreSavedWindAnswers(
  answers: Record<string, unknown> | null | undefined,
): {
  windAnswers: WindAnswers;
  roofShapeUserSet: boolean;
  roofMaterialUserSet: boolean;
  swrUserSelected: boolean;
} | null {
  if (!answers || typeof answers !== "object") return null;
  const parsed = windAnswersSchema.safeParse(answers.quote_wind_answers);
  if (!parsed.success) return null;
  return {
    windAnswers: parsed.data,
    roofShapeUserSet: answers.roof_shape_user_set === true,
    roofMaterialUserSet: answers.roof_material_user_set === true,
    swrUserSelected: answers.swr_user_selected === true,
  };
}

/** Autosave runs only after this property's saved answers were applied
 * (both the general rehydrate and the wind-answer restore) and auth has
 * finished loading the user's saved scenarios. */
export function autosaveReady(args: {
  authHydrated: boolean;
  address: string;
  addressParam: string;
  answersHydratedFor: string | null;
  windHydratedFor: string | null;
}): boolean {
  if (!args.authHydrated || !args.address.trim()) return false;
  return args.answersHydratedFor === args.addressParam && args.windHydratedFor === args.address;
}

/** Debounce for a change: 0 when only discrete answers changed, otherwise
 * the typed-field debounce. `typed` lists the values of free-text/numeric
 * inputs in a stable order. */
export function autosaveDelay(previousTyped: string | null, typed: readonly unknown[]): number {
  const next = JSON.stringify(typed);
  return previousTyped !== null && previousTyped !== next ? TYPED_ANSWER_DEBOUNCE_MS : 0;
}
