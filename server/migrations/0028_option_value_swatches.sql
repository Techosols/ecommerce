-- 0028_option_value_swatches.sql
-- What a colour actually looks like (docs/catalogue-model.md §5).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why the value and not the variant
--
-- 0007 modelled an option value as a bare string: "Mulberry", "Deep Brown",
-- "Nude 03". That is enough to *pick* a variant and not nearly enough to sell
-- one. A shopper choosing a lipstick is choosing a colour, and a list of names
-- makes them guess at it; every storefront that sells anything with a shade
-- shows the shade.
--
-- The swatch belongs to the option *value*, not to the variant, because
-- "Mulberry" is the same colour in the 5g and the 40g. Hanging it off the
-- variant would store it twice for a two-axis product and let the two copies
-- disagree — and a catalogue where the same named shade renders differently
-- depending on which size you happened to click is worse than no swatch.
--
-- ── Why a hex and not a name ─────────────────────────────────────────────────
--
-- CSS colour names cover 148 words. A cosmetics catalogue is "NBM01 Deep
-- Brown" and "01 Mulberry"; a paint catalogue is "Elephant's Breath". Deriving
-- a colour from the name works for the handful of values that happen to be
-- English colour words and silently produces the wrong circle for everything
-- else — and a swatch that is confidently wrong is worse than a name, because
-- a name at least admits it does not know.
--
-- So the merchant states it. The column is nullable throughout: most options
-- are not colours at all, and a "Size" value has nothing to put here.
--
-- ── Why normalised, and enforced ─────────────────────────────────────────────
--
-- Stored lower-case `#rrggbb`, and the CHECK says so. Three-digit hex, bare
-- `rrggbb`, `rgb()` and named colours are all refused rather than accepted and
-- normalised later, because the alternative is a column holding five spellings
-- of the same red and a rendering path that has to know all of them.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE product_option_values
  ADD COLUMN swatch_hex text;

ALTER TABLE product_option_values
  ADD CONSTRAINT option_value_swatch_is_normalised_hex
  CHECK (swatch_hex IS NULL OR swatch_hex ~ '^#[0-9a-f]{6}$');

COMMENT ON COLUMN product_option_values.swatch_hex IS
  'What this value looks like, as lower-case #rrggbb. Null for options that are not colours, and for colours the merchant has not described yet — the storefront falls back to the name.';
