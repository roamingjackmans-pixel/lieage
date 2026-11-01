// Player pictures, fallback names and the question categories.

export const AVATARS = [
  '🦊', '🐸', '🐼', '🐨', '🐯', '🦁', '🐵', '🐙', '🦄', '🐲', '🦉', '🐧', '🦖', '🐝', '🐢', '🦀',
  '🐳', '🦩', '🦔', '🐹', '🐰', '🐻', '🐷', '🐮', '🦥', '🦦', '🐌', '🦭', '🤠', '👽', '🤖', '👻',
  '🎃', '🧙', '🧛', '🧜', '🥷', '🕵️', '🤡', '😎', '🥸', '🧐', '😇', '😈', '💀', '🍕', '🌮', '🍩',
];

// for players who don't type a name
export const PLAYER_NAMES = [
  'Fibsy', 'Tall Tale', 'Sly Fox', 'Pants On Fire', 'Fishy', 'Sneaky Pete', 'Mr. Honest', 'Shifty',
  'Big Fibber', 'Poker Face', 'Slick', 'Sir Bluffs', 'Smooth Talker', 'Whopper', 'Truth Hound', 'Hoodwink',
  'Dodgy', 'Wink', 'Sherlock', 'Bamboozle', 'Humbug', 'Malarkey', 'Hogwash', 'Baloney',
];

// question categories: the key is the file name in data/prompts/
export const CATS = {
  animals: { name: 'Animals & Nature', icon: '🐾' },
  history: { name: 'History', icon: '🏰' },
  food: { name: 'Food & Drink', icon: '🍔' },
  laws: { name: 'Laws & Crime', icon: '⚖️' },
  science: { name: 'Science & Inventions', icon: '🔬' },
  popculture: { name: 'Pop Culture', icon: '🎬' },
  sports: { name: 'Sports & Games', icon: '🏆' },
  places: { name: 'Places & Words', icon: '🗺️' },
};
export const catOf = c => CATS[c] || { name: 'Trivia', icon: '❓' };
