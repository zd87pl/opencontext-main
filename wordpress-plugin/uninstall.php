<?php
/**
 * Uninstall script for OpenContext WordPress Plugin
 * This file is called when the plugin is deleted via WordPress admin
 */

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

// Clean up options
delete_option('opencontext_rpc_url');
delete_option('opencontext_passport_contract');
delete_option('opencontext_vault_contract');
delete_option('opencontext_payment_contract');
delete_option('opencontext_gateway_url');
delete_option('opencontext_enable_context_tracking');
delete_option('opencontext_enable_premium_content');
delete_option('opencontext_default_payment_rate');

// Clean up user meta
delete_metadata('user', 0, '_opencontext_wallet', '', true);
delete_metadata('user', 0, '_opencontext_passport', '', true);
delete_metadata('user', 0, '_opencontext_creator_wallet', '', true);
delete_metadata('user', 0, '_opencontext_default_rate', '', true);

// Clean up post meta
delete_metadata('post', 0, '_opencontext_premium', '', true);
delete_metadata('post', 0, '_opencontext_payment_rate', '', true);
delete_metadata('post', 0, '_opencontext_preview_text', '', true);
delete_metadata('post', 0, '_opencontext_unlock_time', '', true);

// Clean up transients and cached data
global $wpdb;

// Remove all OpenContext transients
$wpdb->query($wpdb->prepare(
    "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s",
    '_transient_opencontext_%'
));

$wpdb->query($wpdb->prepare(
    "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s",
    '_transient_timeout_opencontext_%'
));

// Clean up scheduled events
wp_clear_scheduled_hook('opencontext_cleanup_tracking_data');

// Clear any cached data
wp_cache_flush();