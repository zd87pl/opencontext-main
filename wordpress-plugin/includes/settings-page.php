<?php
if (!defined('ABSPATH')) {
    exit;
}

if (isset($_POST['submit'])) {
    check_admin_referer('opencontext_settings_nonce');
    
    $errors = array();
    
    // Validate contract addresses
    $passport_contract = sanitize_text_field($_POST['passport_contract']);
    $vault_contract = sanitize_text_field($_POST['vault_contract']);
    $payment_contract = sanitize_text_field($_POST['payment_contract']);
    
    if (!empty($passport_contract) && !preg_match('/^0x[a-fA-F0-9]{40}$/', $passport_contract)) {
        $errors[] = __('Invalid Passport Contract address format', 'opencontext-wp');
    }
    
    if (!empty($vault_contract) && !preg_match('/^0x[a-fA-F0-9]{40}$/', $vault_contract)) {
        $errors[] = __('Invalid Vault Contract address format', 'opencontext-wp');
    }
    
    if (!empty($payment_contract) && !preg_match('/^0x[a-fA-F0-9]{40}$/', $payment_contract)) {
        $errors[] = __('Invalid Payment Contract address format', 'opencontext-wp');
    }
    
    // Validate payment rate
    $payment_rate = floatval($_POST['default_payment_rate']);
    if ($payment_rate < 0 || $payment_rate > 1000) {
        $errors[] = __('Default payment rate must be between 0 and 1000 USDC per minute', 'opencontext-wp');
    }
    
    if (empty($errors)) {
        update_option('opencontext_rpc_url', sanitize_url($_POST['rpc_url']));
        update_option('opencontext_passport_contract', $passport_contract);
        update_option('opencontext_vault_contract', $vault_contract);
        update_option('opencontext_payment_contract', $payment_contract);
        update_option('opencontext_gateway_url', sanitize_url($_POST['gateway_url']));
        update_option('opencontext_enable_context_tracking', isset($_POST['enable_context_tracking']) ? '1' : '0');
        update_option('opencontext_enable_premium_content', isset($_POST['enable_premium_content']) ? '1' : '0');
        update_option('opencontext_default_payment_rate', $payment_rate);
        
        echo '<div class="notice notice-success"><p>' . __('Settings saved successfully.', 'opencontext-wp') . '</p></div>';
    } else {
        echo '<div class="notice notice-error"><p>' . implode('<br>', $errors) . '</p></div>';
    }
}

$rpc_url = get_option('opencontext_rpc_url', 'https://sepolia.era.zksync.dev');
$passport_contract = get_option('opencontext_passport_contract', '');
$vault_contract = get_option('opencontext_vault_contract', '');
$payment_contract = get_option('opencontext_payment_contract', '');
$gateway_url = get_option('opencontext_gateway_url', 'https://gateway.opencontext.network');
$enable_context_tracking = get_option('opencontext_enable_context_tracking', '1');
$enable_premium_content = get_option('opencontext_enable_premium_content', '1');
$default_payment_rate = get_option('opencontext_default_payment_rate', '0.01');
?>

<div class="wrap">
    <h1><?php echo esc_html(get_admin_page_title()); ?></h1>
    
    <form method="post" action="">
        <?php wp_nonce_field('opencontext_settings_nonce'); ?>
        
        <table class="form-table">
            <tr>
                <th scope="row">
                    <label for="rpc_url"><?php _e('RPC URL', 'opencontext-wp'); ?></label>
                </th>
                <td>
                    <input type="url" id="rpc_url" name="rpc_url" value="<?php echo esc_attr($rpc_url); ?>" class="regular-text" required />
                    <p class="description"><?php _e('zkSync Era RPC endpoint URL (testnet or mainnet)', 'opencontext-wp'); ?></p>
                </td>
            </tr>
            
            <tr>
                <th scope="row">
                    <label for="passport_contract"><?php _e('Passport Contract', 'opencontext-wp'); ?></label>
                </th>
                <td>
                    <input type="text" id="passport_contract" name="passport_contract" value="<?php echo esc_attr($passport_contract); ?>" class="regular-text" required />
                    <p class="description"><?php _e('PassportRegistry contract address', 'opencontext-wp'); ?></p>
                </td>
            </tr>
            
            <tr>
                <th scope="row">
                    <label for="vault_contract"><?php _e('Vault Contract', 'opencontext-wp'); ?></label>
                </th>
                <td>
                    <input type="text" id="vault_contract" name="vault_contract" value="<?php echo esc_attr($vault_contract); ?>" class="regular-text" required />
                    <p class="description"><?php _e('ContextVault contract address', 'opencontext-wp'); ?></p>
                </td>
            </tr>
            
            <tr>
                <th scope="row">
                    <label for="payment_contract"><?php _e('Payment Contract', 'opencontext-wp'); ?></label>
                </th>
                <td>
                    <input type="text" id="payment_contract" name="payment_contract" value="<?php echo esc_attr($payment_contract); ?>" class="regular-text" required />
                    <p class="description"><?php _e('PaymentStream contract address', 'opencontext-wp'); ?></p>
                </td>
            </tr>
            
            <tr>
                <th scope="row">
                    <label for="gateway_url"><?php _e('Gateway URL', 'opencontext-wp'); ?></label>
                </th>
                <td>
                    <input type="url" id="gateway_url" name="gateway_url" value="<?php echo esc_attr($gateway_url); ?>" class="regular-text" required />
                    <p class="description"><?php _e('OpenContext Gateway proxy URL', 'opencontext-wp'); ?></p>
                </td>
            </tr>
        </table>
        
        <h2><?php _e('Features', 'opencontext-wp'); ?></h2>
        
        <table class="form-table">
            <tr>
                <th scope="row"><?php _e('Context Tracking', 'opencontext-wp'); ?></th>
                <td>
                    <fieldset>
                        <legend class="screen-reader-text"><span><?php _e('Context Tracking', 'opencontext-wp'); ?></span></legend>
                        <label for="enable_context_tracking">
                            <input type="checkbox" id="enable_context_tracking" name="enable_context_tracking" value="1" <?php checked($enable_context_tracking, '1'); ?> />
                            <?php _e('Enable user context tracking and storage', 'opencontext-wp'); ?>
                        </label>
                        <p class="description"><?php _e('Store encrypted user reading preferences and history for personalization', 'opencontext-wp'); ?></p>
                    </fieldset>
                </td>
            </tr>
            
            <tr>
                <th scope="row"><?php _e('Premium Content', 'opencontext-wp'); ?></th>
                <td>
                    <fieldset>
                        <legend class="screen-reader-text"><span><?php _e('Premium Content', 'opencontext-wp'); ?></span></legend>
                        <label for="enable_premium_content">
                            <input type="checkbox" id="enable_premium_content" name="enable_premium_content" value="1" <?php checked($enable_premium_content, '1'); ?> />
                            <?php _e('Enable premium content with streaming payments', 'opencontext-wp'); ?>
                        </label>
                        <p class="description"><?php _e('Allow content creators to monetize posts with micropayments', 'opencontext-wp'); ?></p>
                    </fieldset>
                </td>
            </tr>
            
            <tr>
                <th scope="row">
                    <label for="default_payment_rate"><?php _e('Default Payment Rate', 'opencontext-wp'); ?></label>
                </th>
                <td>
                    <input type="number" id="default_payment_rate" name="default_payment_rate" value="<?php echo esc_attr($default_payment_rate); ?>" step="0.001" min="0" class="small-text" />
                    <span><?php _e('USDC per minute', 'opencontext-wp'); ?></span>
                    <p class="description"><?php _e('Default streaming payment rate for premium content', 'opencontext-wp'); ?></p>
                </td>
            </tr>
        </table>
        
        <h2><?php _e('Contract Addresses', 'opencontext-wp'); ?></h2>
        
        <div class="opencontext-contract-info">
            <h3><?php _e('Testnet (zkSync Era Sepolia)', 'opencontext-wp'); ?></h3>
            <div class="contract-grid">
                <div class="contract-item">
                    <strong><?php _e('PassportRegistry:', 'opencontext-wp'); ?></strong>
                    <code>0x1234567890123456789012345678901234567890</code>
                </div>
                <div class="contract-item">
                    <strong><?php _e('ContextVault:', 'opencontext-wp'); ?></strong>
                    <code>0x2345678901234567890123456789012345678901</code>
                </div>
                <div class="contract-item">
                    <strong><?php _e('PaymentStream:', 'opencontext-wp'); ?></strong>
                    <code>0x3456789012345678901234567890123456789012</code>
                </div>
            </div>
            
            <p class="description">
                <?php _e('Copy these addresses to the fields above, or use your own deployed contracts.', 'opencontext-wp'); ?>
                <a href="https://docs.opencontext.network/contracts" target="_blank"><?php _e('View deployment guide', 'opencontext-wp'); ?></a>
            </p>
        </div>
        
        <h2><?php _e('Shortcodes', 'opencontext-wp'); ?></h2>
        
        <div class="opencontext-shortcodes">
            <div class="shortcode-item">
                <strong><code>[opencontext_wallet]</code></strong>
                <p><?php _e('Display wallet connection widget', 'opencontext-wp'); ?></p>
                <p class="description"><?php _e('Parameters: button_text, style', 'opencontext-wp'); ?></p>
            </div>
            
            <div class="shortcode-item">
                <strong><code>[opencontext_premium rate="0.01"]Content[/opencontext_premium]</code></strong>
                <p><?php _e('Wrap premium content with paywall', 'opencontext-wp'); ?></p>
                <p class="description"><?php _e('Parameters: rate, preview', 'opencontext-wp'); ?></p>
            </div>
            
            <div class="shortcode-item">
                <strong><code>[opencontext_dashboard]</code></strong>
                <p><?php _e('Display creator earnings dashboard', 'opencontext-wp'); ?></p>
                <p class="description"><?php _e('Shows payment streams and revenue analytics', 'opencontext-wp'); ?></p>
            </div>
        </div>
        
        <?php submit_button(); ?>
    </form>
</div>

<style>
.contract-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
    margin: 15px 0;
}

.contract-item {
    padding: 10px;
    background: #f9f9f9;
    border-left: 4px solid #007cba;
}

.contract-item code {
    display: block;
    margin-top: 5px;
    font-family: monospace;
    font-size: 12px;
    color: #666;
}

.opencontext-shortcodes {
    background: #fff;
    border: 1px solid #ddd;
    padding: 20px;
    margin: 20px 0;
}

.shortcode-item {
    margin-bottom: 20px;
    padding-bottom: 15px;
    border-bottom: 1px solid #eee;
}

.shortcode-item:last-child {
    border-bottom: none;
    margin-bottom: 0;
}

.shortcode-item strong {
    color: #007cba;
}
</style>