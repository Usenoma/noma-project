-- Ghost Payment hardening: every agent purchase needs an explicit user confirmation, and the
-- event trail records the request/decision.

ALTER TABLE ghost_mission_events DROP CONSTRAINT IF EXISTS ghost_mission_events_kind_check;
ALTER TABLE ghost_mission_events ADD CONSTRAINT ghost_mission_events_kind_check
  CHECK (kind IN ('search','fetch','permission_ask','permission_grant','permission_deny',
                  'alias_used','data_shared','present','purchase','purchase_request','purchase_cancel'));
