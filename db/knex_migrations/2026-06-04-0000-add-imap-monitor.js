exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.string("imap_username", 255).defaultTo(null);
        table.string("imap_password", 255).defaultTo(null);
        table.string("imap_protocol", 10).defaultTo("imap");
        table.text("imap_search_query").defaultTo(null);
        table.string("imap_search_field", 20).defaultTo("subject");
        table.boolean("imap_delete_after_check").defaultTo(false);
        table.string("imap_mailbox", 255).defaultTo("INBOX");
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("imap_username");
        table.dropColumn("imap_password");
        table.dropColumn("imap_protocol");
        table.dropColumn("imap_search_query");
        table.dropColumn("imap_search_field");
        table.dropColumn("imap_delete_after_check");
        table.dropColumn("imap_mailbox");
    });
};
