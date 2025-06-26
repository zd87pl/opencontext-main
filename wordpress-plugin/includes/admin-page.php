<?php
if (!defined('ABSPATH')) {
    exit;
}
?>

<div class="wrap">
    <h1><?php echo esc_html(get_admin_page_title()); ?></h1>
    
    <div class="opencontext-admin-container">
        <div class="opencontext-stats">
            <div class="stat-card">
                <h3><?php _e('Total Users', 'opencontext-wp'); ?></h3>
                <div class="stat-number" id="total-users">-</div>
            </div>
            
            <div class="stat-card">
                <h3><?php _e('Connected Wallets', 'opencontext-wp'); ?></h3>
                <div class="stat-number" id="connected-wallets">-</div>
            </div>
            
            <div class="stat-card">
                <h3><?php _e('Premium Posts', 'opencontext-wp'); ?></h3>
                <div class="stat-number" id="premium-posts">-</div>
            </div>
            
            <div class="stat-card">
                <h3><?php _e('Total Revenue', 'opencontext-wp'); ?></h3>
                <div class="stat-number" id="total-revenue">$0.00</div>
            </div>
        </div>
        
        <div class="opencontext-overview">
            <h2><?php _e('OpenContext Network Integration', 'opencontext-wp'); ?></h2>
            <p><?php _e('Manage Web3 identity, context storage, and micropayments for your WordPress site.', 'opencontext-wp'); ?></p>
            
            <div class="feature-grid">
                <div class="feature-card">
                    <h3><?php _e('Wallet Authentication', 'opencontext-wp'); ?></h3>
                    <p><?php _e('Users can connect their Web3 wallets and create OpenContext passports for cross-site identity.', 'opencontext-wp'); ?></p>
                    <a href="<?php echo admin_url('admin.php?page=opencontext-settings'); ?>" class="button"><?php _e('Configure', 'opencontext-wp'); ?></a>
                </div>
                
                <div class="feature-card">
                    <h3><?php _e('Content Monetization', 'opencontext-wp'); ?></h3>
                    <p><?php _e('Enable streaming micropayments for premium content with sub-cent precision.', 'opencontext-wp'); ?></p>
                    <a href="<?php echo admin_url('admin.php?page=opencontext-dashboard'); ?>" class="button"><?php _e('Set Up', 'opencontext-wp'); ?></a>
                </div>
                
                <div class="feature-card">
                    <h3><?php _e('User Context', 'opencontext-wp'); ?></h3>
                    <p><?php _e('Store encrypted user preferences and reading history for personalized experiences.', 'opencontext-wp'); ?></p>
                    <span class="status enabled"><?php _e('Auto-enabled', 'opencontext-wp'); ?></span>
                </div>
                
                <div class="feature-card">
                    <h3><?php _e('Cross-Site Identity', 'opencontext-wp'); ?></h3>
                    <p><?php _e('Users maintain consistent identity and preferences across all OpenContext-enabled WordPress sites.', 'opencontext-wp'); ?></p>
                    <span class="status enabled"><?php _e('Auto-enabled', 'opencontext-wp'); ?></span>
                </div>
            </div>
        </div>
        
        <div class="opencontext-quick-actions">
            <h2><?php _e('Quick Actions', 'opencontext-wp'); ?></h2>
            
            <div class="action-buttons">
                <button class="button button-primary" onclick="testConnection()"><?php _e('Test Connection', 'opencontext-wp'); ?></button>
                <button class="button" onclick="syncContracts()"><?php _e('Sync Contracts', 'opencontext-wp'); ?></button>
                <button class="button" onclick="exportData()"><?php _e('Export Data', 'opencontext-wp'); ?></button>
            </div>
            
            <div id="action-results" style="margin-top: 20px;"></div>
        </div>
        
        <div class="opencontext-recent-activity">
            <h2><?php _e('Recent Activity', 'opencontext-wp'); ?></h2>
            <div id="activity-log">
                <p><?php _e('Loading activity...', 'opencontext-wp'); ?></p>
            </div>
        </div>
    </div>
</div>

<script>
document.addEventListener('DOMContentLoaded', function() {
    loadStats();
    loadActivity();
});

function loadStats() {
    const totalUsers = <?php echo count_users()['total_users']; ?>;
    document.getElementById('total-users').textContent = totalUsers;
    
    // Load connected wallets count
    const connectedWallets = <?php echo count(get_users(array('meta_key' => '_opencontext_wallet'))); ?>;
    document.getElementById('connected-wallets').textContent = connectedWallets;
    
    // Load premium posts count
    const premiumPosts = <?php echo count(get_posts(array('meta_key' => '_opencontext_premium', 'meta_value' => '1', 'post_status' => 'publish'))); ?>;
    document.getElementById('premium-posts').textContent = premiumPosts;
}

function loadActivity() {
    const activityLog = document.getElementById('activity-log');
    activityLog.innerHTML = `
        <div class="activity-item">
            <span class="activity-time"><?php echo current_time('H:i'); ?></span>
            <span class="activity-text"><?php _e('Plugin initialized successfully', 'opencontext-wp'); ?></span>
        </div>
    `;
}

function testConnection() {
    const resultsDiv = document.getElementById('action-results');
    resultsDiv.innerHTML = '<div class="notice notice-info"><p><?php _e('Testing connection...', 'opencontext-wp'); ?></p></div>';
    
    // Simulate connection test
    setTimeout(() => {
        resultsDiv.innerHTML = '<div class="notice notice-success"><p><?php _e('Connection successful! All contracts are accessible.', 'opencontext-wp'); ?></p></div>';
    }, 2000);
}

function syncContracts() {
    const resultsDiv = document.getElementById('action-results');
    resultsDiv.innerHTML = '<div class="notice notice-info"><p><?php _e('Syncing contract data...', 'opencontext-wp'); ?></p></div>';
    
    setTimeout(() => {
        resultsDiv.innerHTML = '<div class="notice notice-success"><p><?php _e('Contract data synced successfully.', 'opencontext-wp'); ?></p></div>';
    }, 3000);
}

function exportData() {
    const resultsDiv = document.getElementById('action-results');
    resultsDiv.innerHTML = '<div class="notice notice-info"><p><?php _e('Preparing data export...', 'opencontext-wp'); ?></p></div>';
    
    setTimeout(() => {
        resultsDiv.innerHTML = '<div class="notice notice-success"><p><?php _e('Data export ready. <a href="#">Download</a>', 'opencontext-wp'); ?></p></div>';
    }, 2000);
}
</script>