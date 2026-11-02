-- VPN and proxy were retired from the marketplace (013 keeps the seed capsules sellable).
-- Rework the two seeded capsules so every item maps to a live category.

UPDATE capsule_items
   SET category = 'giftcard', title = 'Gift card — app-store and digital credits on the road'
 WHERE capsule_id = (SELECT id FROM capsules WHERE slug = 'travel-kit') AND category = 'vpn';

UPDATE capsules
   SET outcome = 'Stay connected and covered abroad: mobile data for your destination plus digital gift-card credits for the apps that need them.'
 WHERE slug = 'travel-kit';

UPDATE capsule_items
   SET category = 'ai_credits', title = 'AI credits — private models for your server'
 WHERE capsule_id = (SELECT id FROM capsules WHERE slug = 'private-workstation') AND category = 'vpn';

UPDATE capsules
   SET outcome = 'A server you control, with AI credits for the models your work runs on.'
 WHERE slug = 'private-workstation';
