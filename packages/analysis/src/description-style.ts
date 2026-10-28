/**
 * The seller's description style (docs/features/description-style.md): instructions for how the
 * item analysis writes their listing copy. Listora's default style for Depop is the structure
 * measured on a working Depop shop's listings; a seller who sells differently saves their own
 * in Settings, and it replaces the default for their account. The default goes in the cached
 * system prompt, so only a seller's own style adds tokens to a call.
 */
import type { DbExecutor } from '@listora/db';

/** Characters a seller's own style may have (the column's check). */
export const MAX_DESCRIPTION_STYLE_LENGTH = 4_000;

/**
 * Listora's default Depop style. The example is invented (no real listing's text), and it
 * follows every rule of the system prompt: it describes only what the photos would show.
 */
export const DEFAULT_DEPOP_DESCRIPTION_STYLE = `Write the description in these parts, each separated by a blank line:
1. A title line: the brand, the key details, and the item type in title case, then the size
   ("– Size M"), then one emoji that matches the item's main color (🤍 white or cream, 🖤 black,
   💙 blue or denim, 🤎 brown or tan, ❤️ red, 💚 green, 💜 purple, 🩷 pink, 💛 yellow, ✨ metallic
   or sparkly). No hashtags on this line.
2. One to three sentences that open with an enthusiastic lead ("Such a cute…", "Super soft…",
   "Cute … by <brand>"), then run through the fabric, construction, and details (collar, cuffs,
   pockets, hems, lining, print colors).
3. Optional: one or two sentences on how to style it or its vibe ("Perfect for…", "looks so cute
   with…"), naming an era or aesthetic when it fits (Y2K, 70s, 90s, boho, coquette, gorpcore).
4. A list of "• " lines: "• Brand: …" and "• Size: …" first (sizes spelled out: Small, Medium,
   One Size; numeric sizes as they are), then the color, the material as percentages ("95%
   cotton / 5% elastane"), the origin ("Made in USA"), and one feature per line.
5. A condition sentence that is hedged and points at the photos ("Preowned condition. Please
   review photos for overall condition and normal signs of wear."), naming each flaw plainly and
   where it is.
Hashtags: 4 or 5, lowercase: the brand first, then the item type and the aesthetic.
Tone: warm and upbeat, like telling a friend about it; never pushy, and never mention shipping,
bundles, or offers. Use "/" for alternatives ("cream / ivory") and "+" for "and" in colors
("navy + white"). Aim for 500 to 800 characters before the hashtags.

Example (an invented item):
Levi's Light Wash Denim Trucker Jacket – Size M 💙

Such a classic piece by Levi's in a soft light wash. Features a point collar, button front, two flap chest pockets, side hand pockets and adjustable button tabs at the waist.

Looks so cute thrown over a sundress or with matching jeans for a full 90s denim moment.

• Brand: Levi's
• Size: Medium
• Light wash blue
• 100% cotton
• Button front
• Flap chest pockets

Preowned condition with light fading at the cuffs. Please review photos for overall condition and normal signs of wear.

Hashtags for it: levis, denimjacket, truckerjacket, 90s, vintage`;

/** How the analysis writes one account's copy: the seller's own Depop style, else none. */
export interface DescriptionStyle {
  /** The seller's own Depop style; `null` means Listora's default. */
  readonly depop: string | null;
}

/** The account's description style; an account that never saved one has Listora's default. */
export async function loadDescriptionStyle(
  executor: DbExecutor,
  accountId: string,
): Promise<DescriptionStyle> {
  const row = await executor
    .selectFrom('description_style')
    .select('depop')
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  return { depop: row?.depop ?? null };
}

/**
 * Saves the account's description style: a text replaces the default, `null` goes back to
 * Listora's default. The caller trims the text and checks its length.
 */
export async function saveDescriptionStyle(
  executor: DbExecutor,
  accountId: string,
  style: DescriptionStyle,
): Promise<DescriptionStyle> {
  const { depop } = style;
  if (depop === null) {
    await executor.deleteFrom('description_style').where('account_id', '=', accountId).execute();
    return { depop: null };
  }
  const row = await executor
    .insertInto('description_style')
    .values({ account_id: accountId, depop })
    .onConflict((conflict) => conflict.column('account_id').doUpdateSet({ depop }))
    .returning('depop')
    .executeTakeFirstOrThrow();
  return { depop: row.depop };
}
