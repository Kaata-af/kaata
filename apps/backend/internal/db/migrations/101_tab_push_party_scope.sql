-- One installation may legitimately read both sides through independent Kaata
-- memberships. Registering one book must not replace the other book's alerts.
ALTER TABLE tab_push_subscriptions
 DROP CONSTRAINT tab_push_subscriptions_tab_id_install_id_key;
ALTER TABLE tab_push_subscriptions
 ADD CONSTRAINT tab_push_subscriptions_tab_role_install_key UNIQUE(tab_id,role,install_id);
