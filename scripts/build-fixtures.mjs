#!/usr/bin/env node
/**
 * Builds the demo-mode fixtures in data/fixtures/.
 *
 *   node scripts/build-fixtures.mjs
 *
 * Output files:
 *   entities.json    Catalogue of entities in the same shape Qloo returns from
 *                    /search and /v2/insights (entity_id, name, types, popularity,
 *                    properties, tags, location).
 *   tags.json        Tag objects in the shape /v2/tags returns (id, name, type, parents).
 *   mock-model.json  Mock-only data that never appears in a response: the hidden
 *                    "taste facets" the mock uses to compute deterministic affinities,
 *                    and search synonyms for tags.
 *
 * Artists, films, shows and books are real public works. Every place is fictional
 * and exists only so the demo can plan a night in any city; the UI labels the
 * whole mode "demo data".
 */
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'data', 'fixtures');
mkdirSync(outDir, { recursive: true });

/** Deterministic, Qloo-style uppercase UUID from a seed string. */
function uuid(seed) {
  const h = createHash('sha1').update(seed).digest('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-A${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '');

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------
const tags = [];
const tagFacets = {};
const tagSynonyms = {};
function tag(id, name, type, parents, facets = {}, synonyms = []) {
  tags.push({ id, name, type, parents: parents.map((t) => ({ type: t })) });
  if (Object.keys(facets).length) tagFacets[id] = facets;
  if (synonyms.length) tagSynonyms[id] = synonyms;
  return id;
}
const PLACE = 'urn:entity:place';
const cuisine = (key, name, facets, synonyms) =>
  tag(`urn:tag:genre:place:restaurant:${key}`, name, 'urn:tag:genre:place', [PLACE], facets, synonyms);
const category = (key, name, facets, synonyms) =>
  tag(`urn:tag:category:place:${key}`, name, 'urn:tag:category:place', [PLACE], facets, synonyms);
const music = (key, name) => tag(`urn:tag:genre:music:${key}`, name, 'urn:tag:genre:music', ['urn:entity:artist']);
const media = (key, name) =>
  tag(`urn:tag:genre:media:${key}`, name, 'urn:tag:genre:media', ['urn:entity:movie', 'urn:entity:tv_show', 'urn:entity:book']);

const RESTAURANT = tag('urn:tag:genre:place:restaurant', 'Restaurant', 'urn:tag:genre:place', [PLACE], { foodie: 0.6 }, ['restaurant', 'dinner', 'food']);

const T = {
  korean: cuisine('korean', 'Korean', { korean: 1, spicy: 0.4 }, ['korean', 'korean food', 'kbbq', 'korean bbq', 'bibimbap', 'korean fried chicken', 'kimchi']),
  japanese: cuisine('japanese', 'Japanese', { japanese: 1 }, ['japanese', 'izakaya', 'japanese food']),
  ramen: cuisine('ramen', 'Ramen', { japanese: 0.8, cozy: 0.6, casual: 0.6 }, ['ramen', 'noodles', 'noodle']),
  sushi: cuisine('sushi', 'Sushi', { japanese: 1, upscale: 0.5, foodie: 0.5 }, ['sushi', 'omakase', 'sashimi']),
  mexican: cuisine('mexican', 'Mexican', { mexican: 1, latin: 0.5, spicy: 0.4 }, ['mexican', 'tacos', 'taco', 'burrito', 'mexican food', 'al pastor']),
  thai: cuisine('thai', 'Thai', { spicy: 1, adventurous: 0.4 }, ['thai', 'pad thai', 'thai food', 'curry']),
  italian: cuisine('italian', 'Italian', { italian: 1, cozy: 0.4 }, ['italian', 'pasta', 'italian food']),
  pizza: cuisine('pizza', 'Pizza', { italian: 0.8, casual: 0.8, family: 0.4 }, ['pizza', 'pizzeria']),
  indian: cuisine('indian', 'Indian', { spicy: 0.8, adventurous: 0.5 }, ['indian', 'biryani', 'indian food', 'tikka']),
  chinese: cuisine('chinese', 'Chinese', { family: 0.5, adventurous: 0.4 }, ['chinese', 'dumplings', 'chinese food']),
  dimsum: cuisine('dim_sum', 'Dim Sum', { family: 0.6, casual: 0.5 }, ['dim sum', 'bao', 'dumpling']),
  french: cuisine('french', 'French', { french: 1, romance: 0.5, upscale: 0.5 }, ['french', 'bistro', 'croissant', 'french food']),
  mediterranean: cuisine('mediterranean', 'Mediterranean', { healthy: 0.7, mellow: 0.4 }, ['mediterranean', 'greek', 'falafel', 'hummus', 'mezze']),
  vegan: cuisine('vegan', 'Vegan', { healthy: 1, indie: 0.4 }, ['vegan', 'plant based', 'plant-based']),
  vegetarian: cuisine('vegetarian', 'Vegetarian', { healthy: 0.9 }, ['vegetarian', 'salad', 'veggie']),
  bbq: cuisine('barbecue', 'Barbecue', { casual: 0.7, highenergy: 0.3, retro: 0.3 }, ['bbq', 'barbecue', 'brisket', 'smokehouse', 'ribs']),
  seafood: cuisine('seafood', 'Seafood', { upscale: 0.5, romance: 0.4 }, ['seafood', 'oysters', 'fish', 'lobster']),
  burgers: cuisine('burgers', 'Burgers', { casual: 1, retro: 0.4 }, ['burger', 'burgers', 'fries']),
  vietnamese: cuisine('vietnamese', 'Vietnamese', { adventurous: 0.5, healthy: 0.4 }, ['vietnamese', 'pho', 'banh mi']),
  // Place categories used for the after-dinner slot.
  bar: category('bar', 'Bar', { nightlife: 1 }, ['bar', 'bars', 'drinks', 'pub']),
  cocktail: category('cocktail_bar', 'Cocktail Bar', { nightlife: 0.9, upscale: 0.5, retro: 0.3 }, ['cocktail', 'cocktails', 'speakeasy', 'cocktail bar']),
  jazzclub: category('jazz_club', 'Jazz Club', { jazz: 1, nightlife: 0.7 }, ['jazz club']),
  livemusic: category('live_music_venue', 'Live Music Venue', { indie: 0.6, nightlife: 0.8, highenergy: 0.5 }, ['live music', 'concert', 'gig', 'music venue']),
  comedy: category('comedy_club', 'Comedy Club', { comedy: 1, nightlife: 0.5 }, ['comedy', 'stand-up', 'standup', 'comedy club']),
  karaoke: category('karaoke', 'Karaoke', { pop: 0.8, highenergy: 0.7 }, ['karaoke', 'noraebang']),
  nightclub: category('nightclub', 'Nightclub', { electronic: 0.8, nightlife: 1, highenergy: 1 }, ['club', 'clubbing', 'nightclub', 'dancing']),
  museum: category('museum', 'Museum', { arthouse: 0.8, literary: 0.4, day: 1 }, ['museum', 'museums']),
  gallery: category('art_gallery', 'Art Gallery', { arthouse: 1, day: 0.6 }, ['gallery', 'art', 'art gallery', 'exhibition']),
  garden: category('botanical_garden', 'Botanical Garden', { nature: 1, mellow: 0.7, day: 1 }, ['garden', 'park', 'botanical garden', 'nature']),
  boardgames: category('board_game_cafe', 'Board Game Café', { nerdy: 1, cozy: 0.8 }, ['board games', 'board game cafe', 'games']),
  arcade: category('arcade_bar', 'Arcade Bar', { retro: 0.9, nerdy: 0.8, nightlife: 0.5 }, ['arcade', 'barcade', 'video games']),
  market: category('night_market', 'Night Market', { foodie: 0.6, adventurous: 0.6, casual: 0.6 }, ['market', 'night market', 'street food']),
  bookstore: category('bookstore', 'Bookstore', { literary: 1, cozy: 0.7 }, ['bookstore', 'books', 'bookshop']),
  cinema: category('outdoor_cinema', 'Outdoor Cinema', { arthouse: 0.5, romance: 0.6 }, ['cinema', 'movies', 'outdoor cinema']),
  planetarium: category('planetarium', 'Planetarium', { scifi: 0.9, nerdy: 0.7, day: 0.5 }, ['planetarium', 'space', 'stars']),
  dance: category('dance_hall', 'Dance Hall', { latin: 0.6, highenergy: 0.8, nightlife: 0.7 }, ['salsa', 'dance hall', 'dance class']),
  listening: category('listening_bar', 'Listening Bar', { mellow: 0.8, retro: 0.6, jazz: 0.4 }, ['listening bar', 'vinyl', 'record bar']),
  tiki: category('tiki_bar', 'Tiki Bar', { retro: 0.8, nightlife: 0.7 }, ['tiki', 'tiki bar']),
  wine: category('wine_bar', 'Wine Bar', { romance: 0.6, mellow: 0.6, upscale: 0.4 }, ['wine', 'wine bar', 'natural wine']),
  // Music genres
  indiefolk: music('indie_folk', 'Indie Folk'),
  indierock: music('indie_rock', 'Indie Rock'),
  indiepop: music('indie_pop', 'Indie Pop'),
  kpop: music('k_pop', 'K-Pop'),
  rnb: music('r_and_b', 'R&B'),
  hiphop: music('hip_hop', 'Hip Hop'),
  electronic: music('electronic', 'Electronic'),
  house: music('house', 'House'),
  jazz: music('jazz', 'Jazz'),
  pop: music('pop', 'Pop'),
  latin: music('latin', 'Latin'),
  soul: music('soul', 'Soul'),
  dreampop: music('dream_pop', 'Dream Pop'),
  psych: music('psychedelic', 'Psychedelic'),
  altpop: music('alt_pop', 'Alt Pop'),
  ambient: music('ambient', 'Ambient'),
  jpop: music('j_pop', 'J-Pop'),
  bedroom: music('bedroom_pop', 'Bedroom Pop'),
  songwriter: music('singer_songwriter', 'Singer-Songwriter'),
  softrock: music('soft_rock', 'Soft Rock'),
  neoclassical: music('neo_classical', 'Neo-Classical'),
  funk: music('funk', 'Funk'),
  // Media genres
  drama: media('drama', 'Drama'),
  comedyG: media('comedy', 'Comedy'),
  scifi: media('science_fiction', 'Science Fiction'),
  romance: media('romance', 'Romance'),
  thriller: media('thriller', 'Thriller'),
  animation: media('animation', 'Animation'),
  documentary: media('documentary', 'Documentary'),
  coming: media('coming_of_age', 'Coming of Age'),
  musical: media('musical', 'Musical'),
  arthouseG: media('arthouse', 'Arthouse'),
  adventure: media('adventure', 'Adventure'),
  literary: media('literary_fiction', 'Literary Fiction'),
  memoir: media('memoir', 'Memoir'),
  fantasy: media('fantasy', 'Fantasy'),
  nonfiction: media('nonfiction', 'Nonfiction'),
  food: media('food', 'Food & Cooking'),
  family: media('family', 'Family'),
};

const tagById = Object.fromEntries(tags.map((t) => [t.id, t]));
const tagRef = (id) => ({ id, name: tagById[id].name, type: tagById[id].type });

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------
const entities = {
  'urn:entity:artist': [],
  'urn:entity:movie': [],
  'urn:entity:tv_show': [],
  'urn:entity:book': [],
  'urn:entity:place': [],
};
const entityFacets = {};

function add(type, name, popularity, tagIds, facets, properties = {}, extra = {}) {
  const entity_id = uuid(`${type}:${name}`);
  entities[type].push({
    entity_id,
    name,
    types: [type],
    popularity,
    properties,
    tags: tagIds.map(tagRef),
    ...extra,
  });
  entityFacets[entity_id] = facets;
}

const A = (name, pop, t, f, desc) => add('urn:entity:artist', name, pop, t, f, { short_description: desc });
A('Phoebe Bridgers', 0.93, [T.indiefolk, T.indierock, T.songwriter], { indie: 1, mellow: 0.8, emotional: 1, literary: 0.4 }, 'American singer-songwriter');
A('Mitski', 0.92, [T.indierock, T.altpop], { indie: 1, emotional: 1, arthouse: 0.5, japanese: 0.2 }, 'Japanese-American singer-songwriter');
A('Bon Iver', 0.9, [T.indiefolk], { indie: 0.9, mellow: 1, nature: 0.5, emotional: 0.5 }, 'American indie folk band');
A('Lana Del Rey', 0.95, [T.dreampop, T.altpop], { emotional: 0.8, retro: 0.7, pop: 0.5, romance: 0.5 }, 'American singer and songwriter');
A('Taylor Swift', 0.99, [T.pop, T.songwriter], { pop: 1, emotional: 0.6, romance: 0.6 }, 'American singer-songwriter');
A('Beyoncé', 0.98, [T.rnb, T.pop], { pop: 0.8, highenergy: 0.7, rnb: 1 }, 'American singer and performer');
A('Kendrick Lamar', 0.97, [T.hiphop], { hiphop: 1, literary: 0.5, highenergy: 0.5 }, 'American rapper and songwriter');
A('Frank Ocean', 0.94, [T.rnb, T.altpop], { rnb: 1, mellow: 0.7, emotional: 0.6, indie: 0.4 }, 'American singer and songwriter');
A('SZA', 0.95, [T.rnb, T.pop], { rnb: 1, emotional: 0.6, pop: 0.5 }, 'American singer');
A('Daft Punk', 0.95, [T.electronic, T.house], { electronic: 1, nightlife: 0.8, retro: 0.6, french: 0.6, scifi: 0.4 }, 'French electronic music duo');
A('Fred again..', 0.89, [T.electronic, T.house], { electronic: 1, nightlife: 0.8, emotional: 0.5 }, 'British producer and DJ');
A('Tame Impala', 0.92, [T.psych, T.indiepop], { indie: 0.7, retro: 0.7, electronic: 0.4, mellow: 0.5 }, 'Australian psychedelic music project');
A('Khruangbin', 0.86, [T.psych, T.funk], { mellow: 0.8, retro: 0.8, jazz: 0.4, adventurous: 0.5 }, 'American trio from Houston');
A('Radiohead', 0.94, [T.indierock, T.electronic], { indie: 0.7, arthouse: 0.7, emotional: 0.7, scifi: 0.4 }, 'English rock band');
A('Arctic Monkeys', 0.93, [T.indierock], { indie: 0.8, nightlife: 0.6, retro: 0.5 }, 'English rock band');
A('NewJeans', 0.9, [T.kpop, T.pop], { korean: 1, pop: 1, highenergy: 0.6 }, 'South Korean girl group');
A('BTS', 0.97, [T.kpop, T.pop], { korean: 1, pop: 1, highenergy: 0.7 }, 'South Korean boy band');
A('BLACKPINK', 0.95, [T.kpop, T.pop], { korean: 0.9, pop: 1, highenergy: 0.8, nightlife: 0.5 }, 'South Korean girl group');
A('Bad Bunny', 0.97, [T.latin, T.hiphop], { latin: 1, nightlife: 0.9, highenergy: 0.9 }, 'Puerto Rican rapper and singer');
A('Rosalía', 0.9, [T.latin, T.pop], { latin: 0.9, arthouse: 0.6, pop: 0.5 }, 'Spanish singer and songwriter');
A('Miles Davis', 0.9, [T.jazz], { jazz: 1, retro: 0.7, mellow: 0.6 }, 'American jazz trumpeter');
A('Norah Jones', 0.87, [T.jazz, T.songwriter], { jazz: 0.8, mellow: 1, cozy: 0.8 }, 'American singer and pianist');
A('Kamasi Washington', 0.8, [T.jazz], { jazz: 1, adventurous: 0.6 }, 'American jazz saxophonist');
A('Billie Eilish', 0.97, [T.altpop, T.pop], { pop: 0.8, emotional: 0.7, indie: 0.5 }, 'American singer-songwriter');
A('Olivia Rodrigo', 0.95, [T.pop], { pop: 0.9, emotional: 0.8 }, 'American singer-songwriter');
A('Fleetwood Mac', 0.93, [T.softrock], { retro: 1, mellow: 0.6, romance: 0.5 }, 'British-American rock band');
A('Stevie Wonder', 0.93, [T.soul, T.funk], { retro: 0.8, rnb: 0.7, highenergy: 0.4, family: 0.5 }, 'American singer and multi-instrumentalist');
A('Hozier', 0.91, [T.indiefolk, T.soul], { indie: 0.6, emotional: 0.7, literary: 0.6, nature: 0.5 }, 'Irish musician');
A('Vampire Weekend', 0.88, [T.indierock, T.indiepop], { indie: 0.8, literary: 0.6, highenergy: 0.4 }, 'American indie rock band');
A('LCD Soundsystem', 0.86, [T.electronic, T.indierock], { electronic: 0.8, nightlife: 0.9, indie: 0.5 }, 'American dance-punk band');
A('The Weeknd', 0.97, [T.rnb, T.pop], { rnb: 0.7, nightlife: 0.8, retro: 0.5, pop: 0.6 }, 'Canadian singer');
A('Harry Styles', 0.96, [T.pop], { pop: 1, retro: 0.5, romance: 0.4 }, 'English singer');
A('Joji', 0.88, [T.rnb, T.bedroom], { mellow: 0.7, emotional: 0.7, japanese: 0.3, indie: 0.4 }, 'Japanese-Australian singer');
A('Ryuichi Sakamoto', 0.83, [T.ambient, T.neoclassical], { japanese: 1, arthouse: 0.8, mellow: 0.8 }, 'Japanese composer');
A('Hikaru Utada', 0.85, [T.jpop, T.pop], { japanese: 1, pop: 0.8, emotional: 0.6 }, 'Japanese-American singer');
A('Mac DeMarco', 0.85, [T.indierock, T.bedroom], { indie: 0.8, mellow: 0.9, cozy: 0.5 }, 'Canadian singer-songwriter');
A('Japanese Breakfast', 0.83, [T.indiepop, T.dreampop], { indie: 0.9, korean: 0.5, emotional: 0.6, literary: 0.4 }, 'American indie pop project');
A('Childish Gambino', 0.92, [T.hiphop, T.funk], { hiphop: 0.7, rnb: 0.5, comedy: 0.5, retro: 0.4 }, 'American artist');
A('Ludovico Einaudi', 0.86, [T.neoclassical], { mellow: 1, emotional: 0.6, cozy: 0.6 }, 'Italian composer and pianist');
A('Gorillaz', 0.92, [T.electronic, T.hiphop], { electronic: 0.6, hiphop: 0.5, scifi: 0.4, comedy: 0.3, nerdy: 0.4 }, 'British virtual band');
A('Clairo', 0.86, [T.bedroom, T.indiepop], { indie: 0.8, mellow: 0.8, cozy: 0.6 }, 'American singer-songwriter');
A('Toro y Moi', 0.8, [T.electronic, T.psych], { electronic: 0.6, mellow: 0.8, retro: 0.4 }, 'American musician');
A('Buena Vista Social Club', 0.84, [T.latin, T.jazz], { latin: 1, retro: 0.8, jazz: 0.5, mellow: 0.5 }, 'Cuban ensemble');
A('IU', 0.88, [T.kpop, T.songwriter], { korean: 1, pop: 0.7, emotional: 0.6, mellow: 0.4 }, 'South Korean singer-songwriter');

const M = (name, year, pop, t, f, desc, type = 'urn:entity:movie') =>
  add(type, name, pop, t, f, { release_year: year, short_description: desc });
M('Parasite', 2019, 0.96, [T.thriller, T.comedyG, T.drama], { korean: 1, arthouse: 0.8, comedy: 0.4, thriller: 0.7 }, 'A poor family schemes its way into a wealthy household.');
M('Lady Bird', 2017, 0.9, [T.coming, T.comedyG, T.drama], { indie: 1, emotional: 0.7, comedy: 0.6, literary: 0.5 }, 'A Sacramento teenager counts down to leaving home.');
M('Blade Runner 2049', 2017, 0.93, [T.scifi, T.drama], { scifi: 1, arthouse: 0.6, mellow: 0.5 }, 'A replicant hunter uncovers a buried secret.');
M('Everything Everywhere All at Once', 2022, 0.94, [T.scifi, T.comedyG, T.adventure], { scifi: 0.6, comedy: 0.8, emotional: 0.7, adventurous: 0.7, family: 0.4 }, 'A laundromat owner fights across the multiverse.');
M('Past Lives', 2023, 0.88, [T.romance, T.drama], { korean: 0.8, romance: 0.9, emotional: 0.9, indie: 0.7 }, 'Two childhood friends reunite decades later.');
M('The Grand Budapest Hotel', 2014, 0.93, [T.comedyG, T.adventure], { comedy: 0.8, retro: 0.6, arthouse: 0.6, nerdy: 0.4 }, 'A concierge and his lobby boy chase a stolen painting.');
M('Spirited Away', 2001, 0.95, [T.animation, T.fantasy, T.family], { japanese: 1, family: 0.8, adventurous: 0.7 }, 'A girl is trapped in a world of spirits.');
M('La La Land', 2016, 0.93, [T.musical, T.romance], { romance: 0.8, jazz: 0.9, retro: 0.5, emotional: 0.6 }, 'A jazz pianist and an actress fall in love in LA.');
M('Moonlight', 2016, 0.88, [T.drama, T.coming], { emotional: 0.9, arthouse: 0.8, indie: 0.6 }, 'Three chapters of one young man’s life in Miami.');
M('Whiplash', 2014, 0.92, [T.drama, T.musical], { jazz: 1, highenergy: 0.7, emotional: 0.5 }, 'A drummer and a ruthless bandleader.');
M('Dune: Part Two', 2024, 0.95, [T.scifi, T.adventure], { scifi: 1, adventurous: 0.9, highenergy: 0.5 }, 'Paul Atreides unites with the Fremen.');
M('Arrival', 2016, 0.91, [T.scifi, T.drama], { scifi: 0.9, emotional: 0.6, literary: 0.6, mellow: 0.4 }, 'A linguist learns the language of visitors.');
M('Amélie', 2001, 0.9, [T.romance, T.comedyG], { french: 1, romance: 0.7, cozy: 0.7, comedy: 0.5 }, 'A shy Parisian waitress quietly changes lives.');
M('In the Mood for Love', 2000, 0.86, [T.romance, T.arthouseG], { romance: 0.9, arthouse: 1, retro: 0.7, mellow: 0.6 }, 'Two neighbours in 1960s Hong Kong.');
M('Mad Max: Fury Road', 2015, 0.93, [T.adventure, T.scifi], { highenergy: 1, adventurous: 0.9, scifi: 0.5 }, 'A desert chase across a wasteland.');
M('Get Out', 2017, 0.93, [T.thriller], { thriller: 1, comedy: 0.3, arthouse: 0.4 }, 'A weekend visit to his girlfriend’s family turns sinister.');
M('Knives Out', 2019, 0.92, [T.thriller, T.comedyG], { thriller: 0.6, comedy: 0.8, nerdy: 0.5 }, 'A detective untangles a family murder mystery.');
M('Before Sunrise', 1995, 0.85, [T.romance, T.drama], { romance: 1, literary: 0.7, mellow: 0.7, indie: 0.5 }, 'Two strangers walk and talk through Vienna.');
M('Aftersun', 2022, 0.84, [T.drama], { emotional: 1, indie: 0.8, mellow: 0.7, retro: 0.4 }, 'A woman revisits a holiday with her father.');
M('Interstellar', 2014, 0.96, [T.scifi, T.adventure], { scifi: 1, emotional: 0.7, adventurous: 0.6 }, 'Explorers travel through a wormhole to save humanity.');
M('The Social Network', 2010, 0.9, [T.drama], { nerdy: 0.9, thriller: 0.4, literary: 0.5 }, 'The founding of Facebook and the lawsuits after.');
M('Chef', 2014, 0.83, [T.comedyG, T.food], { foodie: 1, comedy: 0.6, cozy: 0.6, latin: 0.4 }, 'A chef starts over with a food truck.');
M('Spider-Man: Into the Spider-Verse', 2018, 0.94, [T.animation, T.adventure], { highenergy: 0.7, hiphop: 0.6, family: 0.6, comedy: 0.5, nerdy: 0.5 }, 'Miles Morales becomes Spider-Man.');
M('Decision to Leave', 2022, 0.82, [T.thriller, T.romance], { korean: 0.9, thriller: 0.8, romance: 0.6, arthouse: 0.7 }, 'A detective falls for a murder suspect.');
M('Barbie', 2023, 0.94, [T.comedyG], { pop: 0.8, comedy: 0.8, retro: 0.3 }, 'Barbie leaves Barbieland for the real world.');
M('Oppenheimer', 2023, 0.95, [T.drama], { literary: 0.6, thriller: 0.6, nerdy: 0.6 }, 'The physicist behind the atomic bomb.');
M('Eternal Sunshine of the Spotless Mind', 2004, 0.91, [T.romance, T.scifi], { romance: 0.8, scifi: 0.5, emotional: 0.8, indie: 0.6 }, 'A couple erases each other from memory.');
M('Shoplifters', 2018, 0.82, [T.drama], { japanese: 1, emotional: 0.8, family: 0.5, arthouse: 0.7 }, 'A makeshift family survives on petty theft.');
M('Jiro Dreams of Sushi', 2011, 0.8, [T.documentary, T.food], { japanese: 0.9, foodie: 1, mellow: 0.5 }, 'A portrait of an 85-year-old sushi master.');
M('The Princess Bride', 1987, 0.9, [T.adventure, T.comedyG, T.family], { comedy: 0.7, romance: 0.6, adventurous: 0.6, retro: 0.7, family: 0.6 }, 'A storybook adventure of true love.');
M('Ratatouille', 2007, 0.94, [T.animation, T.food, T.family], { foodie: 1, french: 0.8, family: 0.9, comedy: 0.5 }, 'A rat dreams of cooking in Paris.');
M('Coco', 2017, 0.94, [T.animation, T.family, T.musical], { mexican: 1, family: 0.9, emotional: 0.7 }, 'A boy journeys to the Land of the Dead.');
M('Roma', 2018, 0.84, [T.drama, T.arthouseG], { mexican: 0.9, arthouse: 0.9, emotional: 0.7 }, 'A year in the life of a housekeeper in 1970s Mexico City.');
M('Lost in Translation', 2003, 0.88, [T.drama, T.romance], { japanese: 0.8, mellow: 0.8, romance: 0.5, indie: 0.6, nightlife: 0.4 }, 'Two Americans drift together in Tokyo.');
M('Paddington 2', 2017, 0.9, [T.family, T.comedyG], { family: 1, cozy: 0.9, comedy: 0.7 }, 'Paddington hunts for a stolen pop-up book.');
M('The Matrix', 1999, 0.96, [T.scifi, T.adventure], { scifi: 1, highenergy: 0.7, nerdy: 0.5, electronic: 0.4 }, 'A hacker learns reality is a simulation.');
M('Little Forest', 2018, 0.74, [T.drama, T.food], { korean: 0.9, foodie: 0.8, cozy: 0.9, nature: 0.7, mellow: 0.7 }, 'A young woman returns to her village and cooks through the seasons.');
M('Burning', 2018, 0.78, [T.thriller, T.arthouseG], { korean: 0.9, thriller: 0.7, arthouse: 0.9, literary: 0.6 }, 'A Murakami story turned slow-burn mystery.');

const TV = (name, year, pop, t, f, desc) => M(name, year, pop, t, f, desc, 'urn:entity:tv_show');
TV('The Bear', 2022, 0.94, [T.drama, T.comedyG, T.food], { foodie: 1, highenergy: 0.6, emotional: 0.6 }, 'A fine-dining chef takes over his family sandwich shop.');
TV('Fleabag', 2016, 0.92, [T.comedyG, T.drama], { comedy: 0.9, emotional: 0.6, literary: 0.5 }, 'A woman navigates life and grief in London.');
TV('Succession', 2018, 0.95, [T.drama, T.comedyG], { comedy: 0.6, thriller: 0.5, literary: 0.5 }, 'A media dynasty fights over the throne.');
TV('Severance', 2022, 0.93, [T.scifi, T.thriller], { scifi: 0.8, thriller: 0.7, nerdy: 0.5 }, 'Office workers split their work and home memories.');
TV('Stranger Things', 2016, 0.97, [T.scifi, T.adventure], { scifi: 0.7, retro: 0.9, adventurous: 0.7, nerdy: 0.6 }, 'Kids in 1980s Indiana face the Upside Down.');
TV('Atlanta', 2016, 0.88, [T.comedyG, T.drama], { comedy: 0.8, hiphop: 0.8, arthouse: 0.6 }, 'Two cousins work through the Atlanta rap scene.');
TV('Normal People', 2020, 0.88, [T.romance, T.drama], { romance: 0.9, emotional: 0.9, literary: 0.8, indie: 0.5 }, 'Connell and Marianne drift together and apart over the years.');
TV('The Office', 2005, 0.97, [T.comedyG], { comedy: 1, cozy: 0.7 }, 'A mockumentary about a paper company.');
TV('Squid Game', 2021, 0.97, [T.thriller, T.drama], { korean: 1, thriller: 0.9, highenergy: 0.6 }, 'Debt-ridden players compete in deadly games.');
TV('Abbott Elementary', 2021, 0.89, [T.comedyG], { comedy: 0.9, cozy: 0.7, family: 0.5 }, 'Teachers keep an underfunded Philadelphia classroom going.');
TV("Chef's Table", 2015, 0.85, [T.documentary, T.food], { foodie: 1, arthouse: 0.5, adventurous: 0.5 }, 'Profiles of the world’s most celebrated chefs.');
TV('Shōgun', 2024, 0.9, [T.drama, T.adventure], { japanese: 1, adventurous: 0.7, literary: 0.5 }, 'An English navigator in feudal Japan.');

const B = (name, author, year, pop, t, f) => add('urn:entity:book', name, pop, t, f, { release_year: year, short_description: `Book by ${author}` });
B('Normal People', 'Sally Rooney', 2018, 0.9, [T.literary, T.romance], { romance: 0.8, emotional: 0.9, literary: 1, indie: 0.5 });
B('Dune', 'Frank Herbert', 1965, 0.96, [T.scifi, T.adventure], { scifi: 1, adventurous: 0.8, literary: 0.6 });
B('Project Hail Mary', 'Andy Weir', 2021, 0.92, [T.scifi], { scifi: 1, nerdy: 0.8, comedy: 0.4 });
B('The Midnight Library', 'Matt Haig', 2020, 0.9, [T.literary, T.fantasy], { emotional: 0.7, cozy: 0.6, literary: 0.5 });
B('Tomorrow, and Tomorrow, and Tomorrow', 'Gabrielle Zevin', 2022, 0.89, [T.literary], { nerdy: 0.8, emotional: 0.7, literary: 0.7, retro: 0.4 });
B('Kitchen Confidential', 'Anthony Bourdain', 2000, 0.88, [T.memoir, T.food], { foodie: 1, nightlife: 0.6, adventurous: 0.6 });
B('Pachinko', 'Min Jin Lee', 2017, 0.9, [T.literary, T.drama], { korean: 0.9, japanese: 0.5, literary: 0.9, emotional: 0.7 });
B('Circe', 'Madeline Miller', 2018, 0.9, [T.fantasy, T.literary], { literary: 0.9, adventurous: 0.5, romance: 0.4 });
B('Norwegian Wood', 'Haruki Murakami', 1987, 0.89, [T.literary, T.romance], { japanese: 1, mellow: 0.7, literary: 0.8, emotional: 0.7, retro: 0.4 });
B('Sapiens', 'Yuval Noah Harari', 2011, 0.93, [T.nonfiction], { nerdy: 0.8, literary: 0.6 });
B('The Hobbit', 'J. R. R. Tolkien', 1937, 0.96, [T.fantasy, T.adventure], { adventurous: 0.9, family: 0.6, cozy: 0.5, nerdy: 0.5 });
B('Crying in H Mart', 'Michelle Zauner', 2021, 0.88, [T.memoir, T.food], { korean: 1, foodie: 0.8, emotional: 0.9, literary: 0.7 });
B('Beautiful World, Where Are You', 'Sally Rooney', 2021, 0.84, [T.literary, T.romance], { literary: 0.9, emotional: 0.7, romance: 0.5, indie: 0.5 });
B('The Seven Husbands of Evelyn Hugo', 'Taylor Jenkins Reid', 2017, 0.9, [T.romance, T.drama], { romance: 0.8, retro: 0.6, pop: 0.5 });
B('Klara and the Sun', 'Kazuo Ishiguro', 2021, 0.86, [T.scifi, T.literary], { scifi: 0.6, literary: 0.8, emotional: 0.7, japanese: 0.3 });

// Fictional demo places. Coordinates are offsets around a neutral centre; only
// relative distance matters ("closer" re-plans), and addresses get the
// requested city appended by the mock at request time.
const streets = ['Halsted St', 'Milwaukee Ave', 'Division St', 'Clark St', 'Armitage Ave', 'Damen Ave', 'Fulton Market', 'Wells St', 'Belmont Ave', 'Lincoln Ave', 'Ashland Ave', 'Grand Ave'];
let placeIndex = 0;
function P(name, pop, priceLevel, rating, t, f, desc, dLat, dLon) {
  const n = 1000 + ((placeIndex * 377) % 2400);
  const street = streets[placeIndex % streets.length];
  placeIndex += 1;
  add('urn:entity:place', name, pop, t, f, {
    address: `${n} ${street}`,
    price_level: priceLevel,
    business_rating: rating,
    short_description: desc,
  }, { location: { lat: +(41.8925 + dLat).toFixed(5), lon: +(-87.6262 + dLon).toFixed(5) } });
}
// Restaurants
P('Hanok Table', 0.86, 2, 4.6, [RESTAURANT, T.korean], { korean: 1, spicy: 0.6, nightlife: 0.4, casual: 0.5, foodie: 0.5 }, 'Korean barbecue and banchan at shared tabletop grills.', 0.004, 0.006);
P('Night Market Noodle Bar', 0.8, 1, 4.5, [RESTAURANT, T.ramen, T.japanese], { japanese: 0.8, cozy: 0.6, nightlife: 0.6, casual: 0.8 }, 'Late-night ramen counter with a short, loud playlist.', -0.006, 0.01);
P('Casa Ofrenda', 0.83, 1, 4.6, [RESTAURANT, T.mexican], { mexican: 1, spicy: 0.6, casual: 0.8, latin: 0.6 }, 'Tacos al pastor off the trompo and mezcal flights.', 0.012, -0.004);
P('Saltwater Omakase', 0.78, 4, 4.8, [RESTAURANT, T.sushi, T.japanese], { japanese: 1, upscale: 1, foodie: 0.8 }, 'Twelve-seat omakase counter.', -0.002, -0.012);
P('Little Basil', 0.79, 1, 4.4, [RESTAURANT, T.thai], { spicy: 1, casual: 0.7, cozy: 0.4, adventurous: 0.4 }, 'Neighbourhood Thai with properly hot curries.', 0.018, 0.014);
P('Forno Nove', 0.84, 2, 4.5, [RESTAURANT, T.pizza, T.italian], { italian: 1, casual: 0.6, family: 0.5, cozy: 0.5 }, 'Wood-fired Neapolitan pizza and natural wine.', -0.01, 0.003);
P('Green Room Kitchen', 0.74, 2, 4.4, [RESTAURANT, T.vegan, T.vegetarian], { healthy: 1, indie: 0.5, cozy: 0.5 }, 'Seasonal plant-based small plates.', 0.007, -0.016);
P('Smoke & Pine', 0.8, 2, 4.5, [RESTAURANT, T.bbq], { highenergy: 0.5, casual: 0.7, retro: 0.4, family: 0.4 }, 'Texas-style brisket and a long whiskey list.', -0.015, -0.006);
P('Brasserie Lumière', 0.81, 3, 4.6, [RESTAURANT, T.french], { french: 1, romance: 0.7, upscale: 0.7, retro: 0.4 }, 'Steak frites and candlelit banquettes.', 0.001, 0.017);
P('Golden Lantern Dim Sum', 0.82, 2, 4.4, [RESTAURANT, T.dimsum, T.chinese], { family: 0.7, casual: 0.6, adventurous: 0.4 }, 'Dim sum carts and soup dumplings.', 0.021, -0.009);
P('Spice Route', 0.77, 2, 4.5, [RESTAURANT, T.indian], { spicy: 0.8, cozy: 0.5, adventurous: 0.6 }, 'Regional Indian thalis and tandoor.', -0.019, 0.012);
P('Olive & Fig', 0.76, 2, 4.4, [RESTAURANT, T.mediterranean], { healthy: 0.7, romance: 0.5, mellow: 0.5 }, 'Mezze, grilled fish and a sunny patio.', 0.009, 0.021);
P('Seoul Fried', 0.79, 1, 4.5, [RESTAURANT, T.korean], { korean: 0.9, casual: 0.9, nightlife: 0.6, highenergy: 0.5 }, 'Korean fried chicken, soju and K-pop on the speakers.', 0.003, -0.002);
P('Izakaya Hoshi', 0.8, 2, 4.6, [RESTAURANT, T.japanese], { japanese: 1, nightlife: 0.8, casual: 0.5, foodie: 0.6 }, 'Skewers, highballs and a vinyl wall.', -0.004, 0.008);
P('Tidewater Oyster House', 0.75, 3, 4.5, [RESTAURANT, T.seafood], { upscale: 0.7, romance: 0.6, foodie: 0.6 }, 'Oysters, crudo and a raw bar.', 0.015, 0.002);
P('Corner Counter', 0.78, 1, 4.3, [RESTAURANT, T.burgers], { casual: 1, retro: 0.5, family: 0.5 }, 'Smash burgers and milkshakes at a diner counter.', -0.008, -0.019);
P('Pho Lantern', 0.73, 1, 4.4, [RESTAURANT, T.vietnamese], { adventurous: 0.6, casual: 0.8, healthy: 0.4 }, 'Slow-simmered pho and banh mi.', 0.024, 0.006);
// After-dinner places
P('Blue Hour Jazz Club', 0.82, 2, 4.7, [T.jazzclub, T.livemusic, T.bar], { jazz: 1, nightlife: 0.8, retro: 0.5, mellow: 0.5, romance: 0.4 }, 'Two sets a night from local trios.', 0.006, 0.004);
P('Hidden Garden Speakeasy', 0.79, 3, 4.6, [T.cocktail, T.bar], { nightlife: 0.9, romance: 0.6, retro: 0.6, upscale: 0.6 }, 'Cocktails behind an unmarked door.', -0.003, 0.012);
P('Echo Hall', 0.84, 2, 4.5, [T.livemusic, T.bar], { indie: 1, nightlife: 0.8, highenergy: 0.6 }, '600-capacity room for touring indie bands.', 0.011, -0.008);
P('Analog Arcade Bar', 0.8, 1, 4.5, [T.arcade, T.bar], { retro: 1, nerdy: 0.9, nightlife: 0.6, comedy: 0.3 }, 'Pinball, cabinets and craft beer.', -0.009, 0.006);
P('Open Mic Cellar', 0.74, 1, 4.4, [T.comedy, T.bar], { comedy: 1, nightlife: 0.6, casual: 0.5 }, 'Stand-up in a basement, five dollars at the door.', 0.002, -0.013);
P('Side B Vinyl Lounge', 0.76, 2, 4.6, [T.listening, T.bar], { retro: 0.7, mellow: 0.9, jazz: 0.5, indie: 0.5, japanese: 0.3 }, 'Hi-fi listening bar with a deep record wall.', -0.005, -0.003);
P('Karaoke Box Neon', 0.78, 1, 4.4, [T.karaoke, T.bar], { korean: 0.6, pop: 1, highenergy: 0.8, nightlife: 0.7 }, 'Private karaoke rooms with a K-pop heavy catalogue.', 0.004, 0.009);
P('Disco Laundry', 0.81, 2, 4.3, [T.nightclub, T.bar], { electronic: 1, nightlife: 1, highenergy: 1, latin: 0.4 }, 'House and disco until late.', -0.012, 0.015);
P('Lumen Immersive Gallery', 0.77, 2, 4.4, [T.gallery], { arthouse: 0.9, scifi: 0.5, electronic: 0.4, day: 0.5 }, 'Room-sized light and sound installations.', 0.016, 0.011);
P('Board & Brew Café', 0.75, 1, 4.6, [T.boardgames], { nerdy: 1, cozy: 0.9, casual: 0.7 }, 'Seven hundred board games and good coffee.', -0.017, 0.001);
P('Moonlight Rooftop Cinema', 0.79, 2, 4.5, [T.cinema], { arthouse: 0.6, romance: 0.7, indie: 0.5 }, 'Cult classics on a rooftop with blankets.', 0.008, -0.011);
P('Contemporary Art Annex', 0.8, 1, 4.6, [T.museum, T.gallery], { arthouse: 1, literary: 0.5, day: 1 }, 'Rotating contemporary exhibitions.', -0.001, 0.019);
P('Bloom Conservatory', 0.82, 1, 4.8, [T.garden], { nature: 1, mellow: 0.8, day: 1, romance: 0.3 }, 'Glasshouses of palms, ferns and orchids.', 0.026, -0.014);
P('Riverwalk Night Market', 0.8, 1, 4.5, [T.market], { foodie: 0.7, adventurous: 0.7, casual: 0.7, nightlife: 0.5 }, 'Street food stalls along the river.', -0.006, -0.009);
P('Paper Moon Bookshop Bar', 0.73, 2, 4.7, [T.bookstore, T.wine], { literary: 1, cozy: 0.9, indie: 0.6, mellow: 0.5 }, 'Second-hand books and wine by the glass.', 0.013, 0.005);
P('Tiki Tide Lounge', 0.74, 2, 4.3, [T.tiki, T.bar], { retro: 0.8, nightlife: 0.7, latin: 0.3 }, 'Rum drinks under bamboo and neon.', -0.014, 0.009);
P('Salsa Social', 0.72, 1, 4.5, [T.dance, T.bar], { latin: 1, highenergy: 0.8, nightlife: 0.8 }, 'Beginner lesson at nine, open floor after.', 0.019, -0.003);
P('Pixel Planetarium', 0.79, 1, 4.6, [T.planetarium], { scifi: 1, nerdy: 0.8, mellow: 0.4, day: 0.6 }, 'Dome shows and late-night laser sets.', -0.022, 0.017);
P('Velvet Wine Room', 0.75, 2, 4.5, [T.wine, T.bar], { romance: 0.7, mellow: 0.7, upscale: 0.4, french: 0.3 }, 'Natural wine, low light, small plates.', 0.005, -0.006);

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------
const write = (name, data) => writeFileSync(join(outDir, name), `${JSON.stringify(data, null, 1)}\n`);
write('entities.json', entities);
write('tags.json', { tags });
write('mock-model.json', {
  note: 'Mock-only taste model. Never returned in a response; used to compute deterministic demo affinities.',
  entityFacets,
  tagFacets,
  tagSynonyms,
});
const counts = Object.fromEntries(Object.entries(entities).map(([k, v]) => [k, v.length]));
console.log('Wrote fixtures:', counts, 'tags:', tags.length);
