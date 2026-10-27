/**
 * Underwear, which some marketplaces take only new. Poshmark's own reasons for removing a listing
 * name "used makeup or underwear" among the items it doesn't support, and it removed Listora's
 * test listing of used boxer briefs minutes after it was listed; Mercari's prohibited items name
 * "items that are soiled with human materials such as used underwear"; Depop prohibits only
 * unclean or unwashed underwear (all read 2026-10-27).
 */
const UNDERWEAR = 'clothing/intimates/underwear';

/** Whether the item's own category is underwear (or one of its subcategories). */
export function isUnderwear(category: string | null): boolean {
  return category === UNDERWEAR || category?.startsWith(`${UNDERWEAR}/`) === true;
}
