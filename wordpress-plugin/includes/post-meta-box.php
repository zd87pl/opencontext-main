<?php
if (!defined('ABSPATH')) {
    exit;
}

class OpenContextPostMetaBox {
    
    public function __construct() {
        add_action('add_meta_boxes', array($this, 'add_meta_box'));
        add_action('save_post', array($this, 'save_meta_box'));
        add_action('admin_enqueue_scripts', array($this, 'enqueue_scripts'));
    }
    
    public function add_meta_box() {
        add_meta_box(
            'opencontext-premium',
            __('OpenContext Premium Content', 'opencontext-wp'),
            array($this, 'meta_box_callback'),
            'post',
            'side',
            'high'
        );
    }
    
    public function enqueue_scripts($hook) {
        if ($hook !== 'post.php' && $hook !== 'post-new.php') {
            return;
        }
        
        wp_enqueue_script(
            'opencontext-post-meta',
            OPENCONTEXT_PLUGIN_URL . 'assets/js/post-meta.js',
            array('jquery'),
            OPENCONTEXT_VERSION,
            true
        );
    }
    
    public function meta_box_callback($post) {
        wp_nonce_field('opencontext_meta_box_nonce', 'opencontext_meta_box_nonce');
        
        $is_premium = get_post_meta($post->ID, '_opencontext_premium', true);
        $payment_rate = get_post_meta($post->ID, '_opencontext_payment_rate', true) ?: '0.01';
        $preview_text = get_post_meta($post->ID, '_opencontext_preview_text', true);
        $unlock_time = get_post_meta($post->ID, '_opencontext_unlock_time', true);
        
        $user_id = get_current_user_id();
        $creator_wallet = get_user_meta($user_id, '_opencontext_creator_wallet', true);
        $default_rate = get_user_meta($user_id, '_opencontext_default_rate', true) ?: '0.01';
        
        if (!$creator_wallet) {
            echo '<div class="notice notice-warning inline">';
            echo '<p><strong>' . __('Setup Required', 'opencontext-wp') . '</strong><br>';
            echo __('Please configure your wallet address in the ', 'opencontext-wp');
            echo '<a href="' . admin_url('admin.php?page=opencontext-dashboard') . '">' . __('Creator Dashboard', 'opencontext-wp') . '</a>';
            echo __(' to enable premium content features.', 'opencontext-wp') . '</p>';
            echo '</div>';
            return;
        }
        ?>
        
        <div class="opencontext-meta-box">
            <p>
                <label for="opencontext_premium">
                    <input type="checkbox" id="opencontext_premium" name="opencontext_premium" value="1" <?php checked($is_premium, '1'); ?> />
                    <strong><?php _e('Enable Premium Content', 'opencontext-wp'); ?></strong>
                </label>
            </p>
            
            <div id="premium-settings" style="<?php echo $is_premium ? '' : 'display:none;'; ?>">
                <hr>
                
                <p>
                    <label for="opencontext_payment_rate">
                        <strong><?php _e('Payment Rate', 'opencontext-wp'); ?></strong>
                    </label><br>
                    <input type="number" id="opencontext_payment_rate" name="opencontext_payment_rate" 
                           value="<?php echo esc_attr($payment_rate); ?>" step="0.001" min="0" class="small-text" />
                    <span><?php _e('USDC per minute', 'opencontext-wp'); ?></span>
                    <button type="button" id="use-default-rate" class="button button-small" data-rate="<?php echo esc_attr($default_rate); ?>">
                        <?php _e('Use Default', 'opencontext-wp'); ?>
                    </button>
                </p>
                
                <p>
                    <label for="opencontext_preview_text">
                        <strong><?php _e('Preview Text', 'opencontext-wp'); ?></strong>
                    </label><br>
                    <textarea id="opencontext_preview_text" name="opencontext_preview_text" rows="3" class="widefat"><?php echo esc_textarea($preview_text); ?></textarea>
                    <span class="description"><?php _e('Optional preview text shown before paywall', 'opencontext-wp'); ?></span>
                </p>
                
                <p>
                    <label for="opencontext_unlock_time">
                        <strong><?php _e('Auto-unlock After', 'opencontext-wp'); ?></strong>
                    </label><br>
                    <select id="opencontext_unlock_time" name="opencontext_unlock_time">
                        <option value=""><?php _e('Never (always premium)', 'opencontext-wp'); ?></option>
                        <option value="86400" <?php selected($unlock_time, '86400'); ?>><?php _e('1 day', 'opencontext-wp'); ?></option>
                        <option value="604800" <?php selected($unlock_time, '604800'); ?>><?php _e('1 week', 'opencontext-wp'); ?></option>
                        <option value="2592000" <?php selected($unlock_time, '2592000'); ?>><?php _e('1 month', 'opencontext-wp'); ?></option>
                        <option value="7776000" <?php selected($unlock_time, '7776000'); ?>><?php _e('3 months', 'opencontext-wp'); ?></option>
                    </select>
                    <span class="description"><?php _e('Content becomes free after this time', 'opencontext-wp'); ?></span>
                </p>
                
                <div class="opencontext-preview">
                    <strong><?php _e('Payment Info:', 'opencontext-wp'); ?></strong><br>
                    <span class="description">
                        <?php printf(
                            __('Payments will be sent to: %s', 'opencontext-wp'),
                            '<code>' . esc_html(substr($creator_wallet, 0, 6) . '...' . substr($creator_wallet, -4)) . '</code>'
                        ); ?>
                    </span>
                </div>
                
                <div class="opencontext-shortcode-helper">
                    <strong><?php _e('Manual Shortcode:', 'opencontext-wp'); ?></strong><br>
                    <code>[opencontext_premium rate="<span id="shortcode-rate"><?php echo esc_html($payment_rate); ?></span>"]Content here[/opencontext_premium]</code>
                    <button type="button" id="copy-shortcode" class="button button-small"><?php _e('Copy', 'opencontext-wp'); ?></button>
                </div>
            </div>
        </div>
        
        <style>
        .opencontext-meta-box {
            padding: 10px 0;
        }
        
        .opencontext-meta-box hr {
            margin: 15px 0;
        }
        
        .opencontext-meta-box p {
            margin: 15px 0;
        }
        
        .opencontext-preview {
            background: #f0f0f1;
            padding: 10px;
            border-radius: 4px;
            margin: 15px 0;
        }
        
        .opencontext-shortcode-helper {
            background: #f9f9f9;
            border: 1px solid #ddd;
            padding: 10px;
            border-radius: 4px;
            margin: 15px 0;
        }
        
        .opencontext-shortcode-helper code {
            display: block;
            margin: 5px 0;
            padding: 8px;
            background: white;
            border-radius: 3px;
            font-size: 12px;
        }
        </style>
        
        <?php
    }
    
    public function save_meta_box($post_id) {
        if (!isset($_POST['opencontext_meta_box_nonce']) || 
            !wp_verify_nonce($_POST['opencontext_meta_box_nonce'], 'opencontext_meta_box_nonce')) {
            return;
        }
        
        if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) {
            return;
        }
        
        if (!current_user_can('edit_post', $post_id)) {
            return;
        }
        
        // Save premium content setting
        $is_premium = isset($_POST['opencontext_premium']) ? '1' : '0';
        update_post_meta($post_id, '_opencontext_premium', $is_premium);
        
        if ($is_premium === '1') {
            // Save payment rate
            $payment_rate = floatval($_POST['opencontext_payment_rate']);
            update_post_meta($post_id, '_opencontext_payment_rate', $payment_rate);
            
            // Save preview text
            $preview_text = sanitize_textarea_field($_POST['opencontext_preview_text']);
            update_post_meta($post_id, '_opencontext_preview_text', $preview_text);
            
            // Save unlock time
            $unlock_time = intval($_POST['opencontext_unlock_time']);
            update_post_meta($post_id, '_opencontext_unlock_time', $unlock_time);
        } else {
            // Remove premium meta if disabled
            delete_post_meta($post_id, '_opencontext_payment_rate');
            delete_post_meta($post_id, '_opencontext_preview_text');
            delete_post_meta($post_id, '_opencontext_unlock_time');
        }
    }
}

new OpenContextPostMetaBox();