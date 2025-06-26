<?php
if (!defined('ABSPATH')) {
    exit;
}

if (!current_user_can('edit_posts')) {
    wp_die(__('You do not have sufficient permissions to access this page.'));
}

$user_id = get_current_user_id();
$wallet_address = get_user_meta($user_id, '_opencontext_wallet', true);
$passport_id = get_user_meta($user_id, '_opencontext_passport', true);

// Handle form submissions
if (isset($_POST['submit_creator_settings'])) {
    check_admin_referer('opencontext_creator_nonce');
    
    update_user_meta($user_id, '_opencontext_creator_wallet', sanitize_text_field($_POST['creator_wallet']));
    update_user_meta($user_id, '_opencontext_default_rate', floatval($_POST['default_rate']));
    update_user_meta($user_id, '_opencontext_creator_bio', sanitize_textarea_field($_POST['creator_bio']));
    
    echo '<div class="notice notice-success"><p>' . __('Creator settings saved successfully.', 'opencontext-wp') . '</p></div>';
}

$creator_wallet = get_user_meta($user_id, '_opencontext_creator_wallet', true) ?: $wallet_address;
$default_rate = get_user_meta($user_id, '_opencontext_default_rate', true) ?: '0.01';
$creator_bio = get_user_meta($user_id, '_opencontext_creator_bio', true);
?>

<div class="wrap">
    <h1><?php echo esc_html(get_admin_page_title()); ?></h1>
    
    <div class="opencontext-dashboard-container">
        
        <?php if (!$wallet_address): ?>
        <div class="notice notice-warning">
            <p>
                <strong><?php _e('Connect Your Wallet', 'opencontext-wp'); ?></strong><br>
                <?php _e('Please connect your Web3 wallet to access creator features.', 'opencontext-wp'); ?>
            </p>
            <div class="opencontext-wallet-widget">
                <button class="opencontext-connect-btn"><?php _e('Connect Wallet', 'opencontext-wp'); ?></button>
                <div class="opencontext-wallet-info" style="display:none;">
                    <span class="wallet-address"></span>
                    <span class="passport-status"></span>
                </div>
            </div>
        </div>
        <?php else: ?>
        
        <div class="opencontext-creator-stats">
            <div class="stats-grid">
                <div class="stat-card">
                    <h3><?php _e('Connected Wallet', 'opencontext-wp'); ?></h3>
                    <div class="stat-value">
                        <code><?php echo esc_html(substr($wallet_address, 0, 6) . '...' . substr($wallet_address, -4)); ?></code>
                    </div>
                    <div class="stat-label"><?php printf(__('Passport #%s', 'opencontext-wp'), $passport_id ?: 'N/A'); ?></div>
                </div>
                
                <div class="stat-card">
                    <h3><?php _e('Premium Posts', 'opencontext-wp'); ?></h3>
                    <div class="stat-value" id="premium-posts-count">-</div>
                    <div class="stat-label"><?php _e('Content monetized', 'opencontext-wp'); ?></div>
                </div>
                
                <div class="stat-card">
                    <h3><?php _e('Active Streams', 'opencontext-wp'); ?></h3>
                    <div class="stat-value" id="active-streams-count">-</div>
                    <div class="stat-label"><?php _e('Current readers', 'opencontext-wp'); ?></div>
                </div>
                
                <div class="stat-card">
                    <h3><?php _e('Total Revenue', 'opencontext-wp'); ?></h3>
                    <div class="stat-value" id="total-revenue">$0.00</div>
                    <div class="stat-label"><?php _e('All time earnings', 'opencontext-wp'); ?></div>
                </div>
            </div>
        </div>
        
        <div class="dashboard-content">
            <div class="dashboard-main">
                <div class="card">
                    <h2><?php _e('Creator Settings', 'opencontext-wp'); ?></h2>
                    
                    <form method="post" action="">
                        <?php wp_nonce_field('opencontext_creator_nonce'); ?>
                        
                        <table class="form-table">
                            <tr>
                                <th scope="row">
                                    <label for="creator_wallet"><?php _e('Payment Wallet', 'opencontext-wp'); ?></label>
                                </th>
                                <td>
                                    <input type="text" id="creator_wallet" name="creator_wallet" value="<?php echo esc_attr($creator_wallet); ?>" class="regular-text" required />
                                    <p class="description"><?php _e('Wallet address where you want to receive payments', 'opencontext-wp'); ?></p>
                                </td>
                            </tr>
                            
                            <tr>
                                <th scope="row">
                                    <label for="default_rate"><?php _e('Default Rate', 'opencontext-wp'); ?></label>
                                </th>
                                <td>
                                    <input type="number" id="default_rate" name="default_rate" value="<?php echo esc_attr($default_rate); ?>" step="0.001" min="0" class="small-text" />
                                    <span><?php _e('USDC per minute', 'opencontext-wp'); ?></span>
                                    <p class="description"><?php _e('Default streaming payment rate for your premium content', 'opencontext-wp'); ?></p>
                                </td>
                            </tr>
                            
                            <tr>
                                <th scope="row">
                                    <label for="creator_bio"><?php _e('Creator Bio', 'opencontext-wp'); ?></label>
                                </th>
                                <td>
                                    <textarea id="creator_bio" name="creator_bio" rows="4" class="large-text"><?php echo esc_textarea($creator_bio); ?></textarea>
                                    <p class="description"><?php _e('Brief description shown to readers before they start payments', 'opencontext-wp'); ?></p>
                                </td>
                            </tr>
                        </table>
                        
                        <?php submit_button(__('Save Creator Settings', 'opencontext-wp'), 'primary', 'submit_creator_settings'); ?>
                    </form>
                </div>
                
                <div class="card">
                    <h2><?php _e('Revenue Analytics', 'opencontext-wp'); ?></h2>
                    <div id="revenue-chart" style="height: 300px; background: #f9f9f9; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #666;">
                        <?php _e('Revenue chart will be displayed here', 'opencontext-wp'); ?>
                    </div>
                </div>
                
                <div class="card">
                    <h2><?php _e('Recent Activity', 'opencontext-wp'); ?></h2>
                    <div id="recent-activity">
                        <div class="activity-item">
                            <div class="activity-icon">💰</div>
                            <div class="activity-content">
                                <div class="activity-title"><?php _e('Payment received', 'opencontext-wp'); ?></div>
                                <div class="activity-meta"><?php _e('$0.05 from reader for "Web3 Guide"', 'opencontext-wp'); ?></div>
                                <div class="activity-time"><?php _e('2 hours ago', 'opencontext-wp'); ?></div>
                            </div>
                        </div>
                        
                        <div class="activity-item">
                            <div class="activity-icon">📝</div>
                            <div class="activity-content">
                                <div class="activity-title"><?php _e('Premium post published', 'opencontext-wp'); ?></div>
                                <div class="activity-meta"><?php _e('"Understanding DeFi Protocols"', 'opencontext-wp'); ?></div>
                                <div class="activity-time"><?php _e('1 day ago', 'opencontext-wp'); ?></div>
                            </div>
                        </div>
                        
                        <div class="activity-item">
                            <div class="activity-icon">👤</div>
                            <div class="activity-content">
                                <div class="activity-title"><?php _e('New reader subscribed', 'opencontext-wp'); ?></div>
                                <div class="activity-meta"><?php _e('Started streaming $0.02/min', 'opencontext-wp'); ?></div>
                                <div class="activity-time"><?php _e('2 days ago', 'opencontext-wp'); ?></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="dashboard-sidebar">
                <div class="card">
                    <h3><?php _e('Quick Actions', 'opencontext-wp'); ?></h3>
                    <div class="quick-actions">
                        <a href="<?php echo admin_url('post-new.php'); ?>" class="button button-primary">
                            <?php _e('Create Premium Post', 'opencontext-wp'); ?>
                        </a>
                        <button class="button" onclick="withdrawEarnings()">
                            <?php _e('Withdraw Earnings', 'opencontext-wp'); ?>
                        </button>
                        <button class="button" onclick="exportAnalytics()">
                            <?php _e('Export Analytics', 'opencontext-wp'); ?>
                        </button>
                    </div>
                </div>
                
                <div class="card">
                    <h3><?php _e('Payment Streams', 'opencontext-wp'); ?></h3>
                    <div id="active-streams">
                        <div class="stream-item">
                            <div class="stream-reader">Reader #1234</div>
                            <div class="stream-rate">$0.02/min</div>
                            <div class="stream-duration">Active 2h 15m</div>
                        </div>
                        
                        <div class="stream-item">
                            <div class="stream-reader">Reader #5678</div>
                            <div class="stream-rate">$0.01/min</div>
                            <div class="stream-duration">Active 45m</div>
                        </div>
                    </div>
                </div>
                
                <div class="card">
                    <h3><?php _e('Top Content', 'opencontext-wp'); ?></h3>
                    <div id="top-content">
                        <div class="content-item">
                            <div class="content-title"><?php _e('Introduction to Web3', 'opencontext-wp'); ?></div>
                            <div class="content-earnings">$12.50</div>
                        </div>
                        
                        <div class="content-item">
                            <div class="content-title"><?php _e('DeFi Explained', 'opencontext-wp'); ?></div>
                            <div class="content-earnings">$8.75</div>
                        </div>
                        
                        <div class="content-item">
                            <div class="content-title"><?php _e('NFT Marketplaces', 'opencontext-wp'); ?></div>
                            <div class="content-earnings">$6.25</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <?php endif; ?>
    </div>
</div>

<script>
document.addEventListener('DOMContentLoaded', function() {
    loadDashboardData();
});

function loadDashboardData() {
    // Load premium posts count
    const premiumPosts = <?php echo count(get_posts(array('author' => $user_id, 'meta_key' => '_opencontext_premium', 'meta_value' => '1', 'post_status' => 'publish'))); ?>;
    document.getElementById('premium-posts-count').textContent = premiumPosts;
    
    // Mock data for demonstration
    document.getElementById('active-streams-count').textContent = '2';
    document.getElementById('total-revenue').textContent = '$27.50';
}

function withdrawEarnings() {
    if (confirm('<?php _e('Initiate withdrawal of available earnings?', 'opencontext-wp'); ?>')) {
        alert('<?php _e('Withdrawal initiated. Funds will be transferred to your wallet.', 'opencontext-wp'); ?>');
    }
}

function exportAnalytics() {
    const data = {
        premiumPosts: document.getElementById('premium-posts-count').textContent,
        activeStreams: document.getElementById('active-streams-count').textContent,
        totalRevenue: document.getElementById('total-revenue').textContent,
        exportDate: new Date().toISOString()
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'opencontext-analytics.json';
    a.click();
    URL.revokeObjectURL(url);
}
</script>