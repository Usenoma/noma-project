-- Pons V2 published events (CurveBuy/CurveSell on the curve, HookFeeCollected on the V4 hook).
-- HookFeeCollected carries no trader, side or trade size, and may be denominated in the memecoin
-- (converted to the quote asset only when the Pons fee sweep operator sweeps the pool).

ALTER TABLE fee_accruals ALTER COLUMN trader DROP NOT NULL;
ALTER TABLE fee_accruals ALTER COLUMN side DROP NOT NULL;
ALTER TABLE fee_accruals ALTER COLUMN trade_quote_amount DROP NOT NULL;
-- currency the fee/tax amounts are denominated in: 'quote' or 'memecoin'
ALTER TABLE fee_accruals ADD COLUMN fee_currency TEXT NOT NULL DEFAULT 'quote' CHECK (fee_currency IN ('quote', 'memecoin'));
-- base trade fee before the protocol split (creator_fee_share_amount = creator's part of it)
ALTER TABLE fee_accruals ADD COLUMN base_fee_amount NUMERIC(78,0) NOT NULL DEFAULT 0;
