// Fuel: built-in nutrition table and the calorie / macro math. Pure functions (Node-testable).
//
// Every food has a fixed list of portion options (the same options the decision model chooses
// from and the user taps). Values are per ONE base unit (`unit`); each option multiplies it.
// Numbers are rounded home-cooking estimates (USDA FoodData Central style values for plain
// versions; Indian dishes as typical home recipes). `cooked: true` dishes get the "cooking fat"
// adjustment; their base values assume a modest amount of oil already.
//
// The coach can supply values for items that are not in this table (estimate_source 'coach').

const P = (key, label, mult) => ({ key, label, mult });
const CUPS = [P('half_cup', '½ cup', 0.5), P('one_cup', '1 cup', 1), P('one_half_cup', '1½ cups', 1.5), P('two_plus', '2+ cups', 2.25)];
const PIECES = [P('one', '1', 1), P('two', '2', 2), P('three', '3', 3), P('four_plus', '4+', 4.5)];
const SLICES = [P('one', '1 slice', 1), P('two', '2 slices', 2), P('three', '3 slices', 3), P('four_plus', '4+ slices', 4.5)];
const PLATE = [P('small', 'Small (¼ plate)', 0.5), P('medium', 'Medium (½ plate)', 1), P('large', 'Large (full plate)', 1.75)];
const SERVING = [P('small', 'Small', 0.6), P('regular', 'Regular', 1), P('large', 'Large', 1.6)];

// kcal, protein_g, carbs_g, fat_g per base unit
const F = (key, name, unit, [kcal, protein_g, carbs_g, fat_g], portions, extra = {}) => ({ key, name, unit, kcal, protein_g, carbs_g, fat_g, portions, ...extra });

export const FOODS = [
  // ---- Indian home food
  F('rice', 'Rice (cooked)', 'cup', [205, 4.3, 45, 0.4], CUPS, { aliases: ['rice', 'chawal', 'basmati', 'jeera rice'] }),
  F('roti', 'Roti / chapati', 'piece', [110, 3.5, 18, 3], PIECES, { aliases: ['roti', 'chapati', 'chapatti', 'phulka'] }),
  F('paratha', 'Paratha', 'piece', [260, 5, 32, 12], PIECES, { cooked: true, aliases: ['paratha', 'parantha', 'aloo paratha'] }),
  F('naan', 'Naan', 'piece', [290, 9, 50, 6], PIECES, { aliases: ['naan'] }),
  F('dal', 'Dal (lentils)', 'cup', [200, 12, 30, 4], CUPS, { cooked: true, aliases: ['dal', 'daal', 'dhal', 'lentil', 'lentils', 'sambar dal', 'toor', 'moong'] }),
  F('rajma', 'Rajma (kidney beans)', 'cup', [240, 13, 38, 5], CUPS, { cooked: true, aliases: ['rajma', 'kidney beans'] }),
  F('chana', 'Chana masala (chickpeas)', 'cup', [270, 12, 40, 8], CUPS, { cooked: true, aliases: ['chana', 'chole', 'chickpea', 'chickpeas'] }),
  F('paneer_curry', 'Paneer curry', 'cup', [380, 18, 12, 29], CUPS, { cooked: true, aliases: ['paneer', 'palak paneer', 'paneer butter masala', 'matar paneer'] }),
  F('chicken_curry', 'Chicken curry', 'cup', [300, 28, 8, 17], CUPS, { cooked: true, aliases: ['chicken curry', 'butter chicken', 'chicken masala', 'chicken tikka masala'] }),
  F('egg_curry', 'Egg curry', 'cup', [280, 14, 10, 20], CUPS, { cooked: true, aliases: ['egg curry', 'anda curry'] }),
  F('sabzi', 'Vegetable sabzi', 'cup', [130, 3.5, 14, 7], CUPS, { cooked: true, aliases: ['sabzi', 'sabji', 'bhindi', 'aloo gobi', 'mixed veg', 'vegetables', 'veggies', 'curry'] }),
  F('sambar', 'Sambar', 'cup', [140, 7, 20, 4], CUPS, { cooked: true, aliases: ['sambar', 'sambhar'] }),
  F('idli', 'Idli', 'piece', [58, 2, 12, 0.2], PIECES, { aliases: ['idli', 'idly'] }),
  F('dosa', 'Dosa', 'piece', [170, 4, 29, 4], PIECES, { cooked: true, aliases: ['dosa', 'masala dosa'] }),
  F('upma', 'Upma', 'cup', [250, 6, 36, 9], CUPS, { cooked: true, aliases: ['upma'] }),
  F('poha', 'Poha', 'cup', [250, 5, 40, 8], CUPS, { cooked: true, aliases: ['poha'] }),
  F('khichdi', 'Khichdi', 'cup', [230, 9, 38, 5], CUPS, { cooked: true, aliases: ['khichdi', 'khichri'] }),
  F('biryani', 'Biryani', 'cup', [330, 15, 42, 11], CUPS, { cooked: true, aliases: ['biryani', 'pulao', 'pilaf'] }),
  F('curd', 'Curd / yogurt', 'cup', [150, 8.5, 11.5, 8], CUPS, { aliases: ['curd', 'dahi', 'yogurt', 'yoghurt', 'raita'] }),
  F('greek_yogurt', 'Greek yogurt (plain)', 'cup', [150, 23, 8, 4], CUPS, { aliases: ['greek yogurt'] }),
  // ---- American / general home food
  F('eggs', 'Eggs (whole)', 'egg', [78, 6.3, 0.6, 5.3], PIECES, { cooked: true, aliases: ['egg', 'eggs', 'omelette', 'omelet', 'scrambled', 'boiled egg', 'fried egg'] }),
  F('toast', 'Toast / bread', 'slice', [80, 3, 14, 1], SLICES, { aliases: ['toast', 'bread', 'slice of bread'] }),
  F('oatmeal', 'Oatmeal (cooked)', 'cup', [160, 6, 28, 3], CUPS, { aliases: ['oatmeal', 'oats', 'porridge'] }),
  F('cereal', 'Cereal with milk', 'cup', [200, 7, 35, 4], CUPS, { aliases: ['cereal', 'granola', 'cornflakes'] }),
  F('chicken_breast', 'Chicken breast (grilled)', 'serving', [230, 43, 0, 5], SERVING, { cooked: true, aliases: ['chicken breast', 'grilled chicken', 'chicken'] }),
  F('salmon', 'Salmon / fish fillet', 'serving', [280, 34, 0, 15], SERVING, { cooked: true, aliases: ['salmon', 'fish', 'tilapia', 'cod'] }),
  F('steak', 'Steak / beef', 'serving', [340, 40, 0, 19], SERVING, { cooked: true, aliases: ['steak', 'beef'] }),
  F('tofu', 'Tofu', 'serving', [180, 19, 4, 11], SERVING, { cooked: true, aliases: ['tofu'] }),
  F('pasta', 'Pasta (with sauce)', 'cup', [280, 10, 48, 6], CUPS, { cooked: true, aliases: ['pasta', 'spaghetti', 'penne', 'mac and cheese', 'noodles'] }),
  F('pizza', 'Pizza', 'slice', [285, 12, 36, 10], SLICES, { aliases: ['pizza'] }),
  F('burger', 'Burger', 'burger', [550, 30, 40, 30], [P('one', '1', 1), P('two', '2', 2)], { aliases: ['burger', 'cheeseburger'] }),
  F('sandwich', 'Sandwich', 'sandwich', [380, 20, 40, 15], [P('half', '½', 0.5), P('one', '1', 1), P('two', '2', 2)], { aliases: ['sandwich', 'sub', 'wrap'] }),
  F('potatoes', 'Potatoes / fries', 'cup', [230, 3, 30, 11], CUPS, { cooked: true, aliases: ['potato', 'potatoes', 'fries', 'hash browns', 'aloo'] }),
  F('salad', 'Green salad (light dressing)', 'bowl', [90, 2, 8, 6], [P('small', 'Side bowl', 0.6), P('regular', 'Bowl', 1), P('large', 'Big bowl', 1.8)], { aliases: ['salad', 'kachumber'] }),
  F('banana', 'Banana', 'piece', [105, 1.3, 27, 0.4], [P('one', '1', 1), P('two', '2', 2)], { aliases: ['banana'] }),
  F('apple', 'Apple', 'piece', [95, 0.5, 25, 0.3], [P('one', '1', 1), P('two', '2', 2)], { aliases: ['apple'] }),
  F('fruit', 'Mixed fruit', 'cup', [80, 1, 20, 0.3], CUPS, { aliases: ['fruit', 'berries', 'grapes', 'orange', 'mango', 'papaya'] }),
  F('milk', 'Milk (2%)', 'cup', [122, 8, 12, 5], CUPS, { aliases: ['milk', 'chai', 'latte'] }),
  F('protein_shake', 'Protein shake', 'scoop', [130, 25, 4, 2], [P('one', '1 scoop', 1), P('two', '2 scoops', 2)], { aliases: ['protein shake', 'shake', 'whey', 'protein'] }),
  F('nuts', 'Nuts', 'handful', [170, 6, 6, 15], [P('small', 'Small handful', 0.6), P('one', 'Handful', 1), P('two', 'Two handfuls', 2)], { aliases: ['nuts', 'almonds', 'peanuts', 'cashews', 'walnuts', 'trail mix'] }),
  F('peanut_butter', 'Peanut butter', 'tbsp', [95, 3.5, 3.5, 8], [P('one', '1 tbsp', 1), P('two', '2 tbsp', 2), P('three', '3 tbsp', 3)], { aliases: ['peanut butter', 'pb'] }),
];

export const FOOD_BY_KEY = Object.fromEntries(FOODS.map((f) => [f.key, f]));

// Meal-level modifiers (same options the decider picks from and the user taps)
export const FAT_LEVELS = ['none', 'a_little', 'a_lot'];
export const FAT_LABELS = { none: 'None', a_little: 'A little', a_lot: 'A lot' };
// Extra oil/ghee per cooked dish beyond what the base values include (per cooked item, not per unit)
export const FAT_EXTRA = { none: { kcal: -20, fat_g: -2.2 }, a_little: { kcal: 0, fat_g: 0 }, a_lot: { kcal: 120, fat_g: 13.5 } };
export const EATEN = { all: 1, most: 0.75, half: 0.5, little: 0.25 };
export const EATEN_LABELS = { all: 'All of it', most: 'Most', half: 'About half', little: 'A little' };

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
export const MAIN_MEALS = ['breakfast', 'lunch', 'dinner'];
export const MEAL_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };

/** Meal type from the local clock (editable in the UI). */
export function guessMeal(date = new Date()) {
  const m = date.getHours() * 60 + date.getMinutes();
  if (m >= 5 * 60 && m < 10 * 60 + 30) return 'breakfast';
  if (m >= 11 * 60 + 30 && m < 15 * 60) return 'lunch';
  if (m >= 17 * 60 + 30 && m < 22 * 60) return 'dinner';
  return 'snack';
}

/** Foods whose aliases appear in a free-text note (used by mock mode and as hints). */
export function foodsInText(text) {
  const t = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')} `;
  const hits = [];
  for (const f of FOODS) {
    if (f.aliases?.some((a) => t.includes(` ${a} `)) && !hits.includes(f.key)) hits.push(f.key);
  }
  // "chicken curry" should not also count as plain chicken breast
  if (hits.includes('chicken_curry')) return hits.filter((k) => k !== 'chicken_breast' && k !== 'sabzi');
  return hits;
}

const r1 = (x) => Math.round(x * 10) / 10;

/**
 * Nutrition of one item.
 * @param {{key?:string, portion?:string, custom?:{kcal,protein_g,carbs_g,fat_g}}} item
 *   custom = coach-provided totals for this item as served (used when key is unknown)
 */
export function itemNutrition(item, { fat = 'a_little', eaten = 'all' } = {}) {
  const ef = EATEN[eaten] ?? 1;
  if (item.custom) {
    const c = item.custom;
    return { kcal: Math.round((+c.kcal || 0) * ef), protein_g: r1((+c.protein_g || 0) * ef), carbs_g: r1((+c.carbs_g || 0) * ef), fat_g: r1((+c.fat_g || 0) * ef) };
  }
  const f = FOOD_BY_KEY[item.key];
  if (!f) return { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  const p = f.portions.find((o) => o.key === item.portion) || f.portions[Math.min(1, f.portions.length - 1)];
  const extra = f.cooked ? (FAT_EXTRA[fat] || FAT_EXTRA.a_little) : { kcal: 0, fat_g: 0 };
  const kcal = Math.max(0, f.kcal * p.mult + extra.kcal);
  const fat_g = Math.max(0, f.fat_g * p.mult + extra.fat_g);
  return { kcal: Math.round(kcal * ef), protein_g: r1(f.protein_g * p.mult * ef), carbs_g: r1(f.carbs_g * p.mult * ef), fat_g: r1(fat_g * ef) };
}

/** Totals for a list of items with meal-level modifiers. Returns per-item rows too. */
export function mealNutrition(items, mods = {}) {
  const rows = (items || []).map((it) => ({ ...it, ...itemNutrition(it, mods) }));
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  return { items: rows, kcal: Math.round(sum('kcal')), protein_g: r1(sum('protein_g')), carbs_g: r1(sum('carbs_g')), fat_g: r1(sum('fat_g')) };
}

/** kcal spread across an item's portion options (used to rank which question matters most). */
export function portionImpact(key) {
  const f = FOOD_BY_KEY[key];
  if (!f) return 0;
  const ks = f.portions.map((p) => f.kcal * p.mult);
  return Math.max(...ks) - Math.min(...ks);
}

export function portionLabel(key, portion) {
  const f = FOOD_BY_KEY[key];
  const p = f?.portions.find((o) => o.key === portion);
  if (!p) return '';
  // bare counts ("2", "4+") get the unit: "2 pieces", "4+ eggs"
  return /^[\d½+]+$/.test(p.label) ? `${p.label} ${f.unit}${p.mult === 1 ? '' : 's'}` : p.label;
}
