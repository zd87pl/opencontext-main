<?php
/**
 * Plugin Name: OpenContext Network
 * Plugin URI: https://github.com/opencontext/opencontext-main
 * Description: Web3 identity, context storage, and micropayments for content creators
 * Version: 1.0.0
 * Author: OpenContext Network
 * License: MIT
 * Text Domain: opencontext-wp
 * Domain Path: /languages
 */

if (!defined('ABSPATH')) {
    exit;
}

define('OPENCONTEXT_VERSION', '1.0.0');
define('OPENCONTEXT_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('OPENCONTEXT_PLUGIN_URL', plugin_dir_url(__FILE__));

class OpenContextWP {
    
    public function __construct() {
        add_action('init', array($this, 'init'));
        add_action('wp_enqueue_scripts', array($this, 'enqueue_scripts'));
        add_action('admin_enqueue_scripts', array($this, 'admin_enqueue_scripts'));
        add_action('admin_menu', array($this, 'admin_menu'));
        add_filter('the_content', array($this, 'filter_content'));
        add_action('wp_ajax_opencontext_auth', array($this, 'handle_auth'));
        add_action('wp_ajax_nopriv_opencontext_auth', array($this, 'handle_auth'));
        add_action('wp_ajax_opencontext_stream_pay', array($this, 'handle_stream_pay'));
        add_action('wp_ajax_nopriv_opencontext_stream_pay', array($this, 'handle_stream_pay'));
        add_action('wp_head', array($this, 'add_meta_tags'));
        
        register_activation_hook(__FILE__, array($this, 'activate'));
        register_deactivation_hook(__FILE__, array($this, 'deactivate'));
        
        // Include additional components
        require_once OPENCONTEXT_PLUGIN_DIR . 'includes/post-meta-box.php';
        require_once OPENCONTEXT_PLUGIN_DIR . 'includes/context-tracker.php';
    }
    
    public function init() {
        load_plugin_textdomain('opencontext-wp', false, dirname(plugin_basename(__FILE__)) . '/languages');
        
        add_shortcode('opencontext_wallet', array($this, 'wallet_shortcode'));
        add_shortcode('opencontext_premium', array($this, 'premium_content_shortcode'));
        add_shortcode('opencontext_dashboard', array($this, 'creator_dashboard_shortcode'));
    }
    
    public function enqueue_scripts() {
        wp_enqueue_script(
            'opencontext-frontend',
            OPENCONTEXT_PLUGIN_URL . 'assets/js/frontend.js',
            array('jquery'),
            OPENCONTEXT_VERSION,
            true
        );
        
        wp_enqueue_script(
            'opencontext-sdk',
            OPENCONTEXT_PLUGIN_URL . 'assets/js/opencontext-sdk.min.js',
            array(),
            OPENCONTEXT_VERSION,
            true
        );
        
        wp_enqueue_style(
            'opencontext-frontend',
            OPENCONTEXT_PLUGIN_URL . 'assets/css/frontend.css',
            array(),
            OPENCONTEXT_VERSION
        );
        
        wp_localize_script('opencontext-frontend', 'opencontext_ajax', array(
            'ajax_url' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce('opencontext_nonce'),
            'config' => array(
                'rpc_url' => get_option('opencontext_rpc_url', ''),
                'passport_contract' => get_option('opencontext_passport_contract', ''),
                'vault_contract' => get_option('opencontext_vault_contract', ''),
                'payment_contract' => get_option('opencontext_payment_contract', ''),
                'gateway_url' => get_option('opencontext_gateway_url', '')
            )
        ));
    }
    
    public function admin_enqueue_scripts($hook) {
        if (strpos($hook, 'opencontext') === false) {
            return;
        }
        
        wp_enqueue_script(
            'opencontext-admin',
            OPENCONTEXT_PLUGIN_URL . 'assets/js/admin.js',
            array('jquery'),
            OPENCONTEXT_VERSION,
            true
        );
        
        wp_enqueue_style(
            'opencontext-admin',
            OPENCONTEXT_PLUGIN_URL . 'assets/css/admin.css',
            array(),
            OPENCONTEXT_VERSION
        );
    }
    
    public function admin_menu() {
        add_menu_page(
            __('OpenContext', 'opencontext-wp'),
            __('OpenContext', 'opencontext-wp'),
            'manage_options',
            'opencontext',
            array($this, 'admin_page'),
            'dashicons-networking',
            30
        );
        
        add_submenu_page(
            'opencontext',
            __('Settings', 'opencontext-wp'),
            __('Settings', 'opencontext-wp'),
            'manage_options',
            'opencontext-settings',
            array($this, 'settings_page')
        );
        
        add_submenu_page(
            'opencontext',
            __('Creator Dashboard', 'opencontext-wp'),
            __('Creator Dashboard', 'opencontext-wp'),
            'edit_posts',
            'opencontext-dashboard',
            array($this, 'dashboard_page')
        );
    }
    
    public function filter_content($content) {
        if (is_singular('post') && in_the_loop() && is_main_query()) {
            $post_id = get_the_ID();
            $is_premium = get_post_meta($post_id, '_opencontext_premium', true);
            
            if ($is_premium) {
                $payment_rate = get_post_meta($post_id, '_opencontext_payment_rate', true);
                $author_wallet = get_user_meta(get_the_author_meta('ID'), '_opencontext_wallet', true);
                
                if ($author_wallet && $payment_rate) {
                    $paywall_html = $this->generate_paywall_html($author_wallet, $payment_rate, $post_id);
                    $content = $paywall_html . $content;
                }
            }
            
            $content .= $this->get_context_tracking_script($post_id);
        }
        
        return $content;
    }
    
    private function generate_paywall_html($author_wallet, $payment_rate, $post_id) {
        return sprintf(
            '<div class="opencontext-paywall" data-author="%s" data-rate="%s" data-post="%s">
                <div class="paywall-content">
                    <h3>%s</h3>
                    <p>%s</p>
                    <button class="opencontext-pay-btn">%s</button>
                </div>
            </div>',
            esc_attr($author_wallet),
            esc_attr($payment_rate),
            esc_attr($post_id),
            __('Premium Content', 'opencontext-wp'),
            sprintf(__('Start streaming %s USDC per minute to access this content', 'opencontext-wp'), $payment_rate),
            __('Start Payment & Read', 'opencontext-wp')
        );
    }
    
    private function get_context_tracking_script($post_id) {
        return sprintf(
            '<script>
                document.addEventListener("DOMContentLoaded", function() {
                    if (window.OpenContextTracker) {
                        window.OpenContextTracker.trackView(%d, "%s", "%s");
                    }
                });
            </script>',
            $post_id,
            esc_js(get_the_title()),
            esc_js(get_the_author())
        );
    }
    
    public function wallet_shortcode($atts) {
        $atts = shortcode_atts(array(
            'button_text' => __('Connect Wallet', 'opencontext-wp'),
            'style' => 'default'
        ), $atts);
        
        return sprintf(
            '<div class="opencontext-wallet-widget">
                <button class="opencontext-connect-btn %s">%s</button>
                <div class="opencontext-wallet-info" style="display:none;">
                    <span class="wallet-address"></span>
                    <span class="passport-status"></span>
                </div>
            </div>',
            esc_attr($atts['style']),
            esc_html($atts['button_text'])
        );
    }
    
    public function premium_content_shortcode($atts, $content = '') {
        $atts = shortcode_atts(array(
            'rate' => '0.01',
            'preview' => ''
        ), $atts);
        
        $preview_content = $atts['preview'] ? '<div class="preview-content">' . esc_html($atts['preview']) . '</div>' : '';
        
        return sprintf(
            '<div class="opencontext-premium-content" data-rate="%s">
                %s
                <div class="premium-content-wrapper" style="display:none;">%s</div>
            </div>',
            esc_attr($atts['rate']),
            $preview_content,
            do_shortcode($content)
        );
    }
    
    public function creator_dashboard_shortcode($atts) {
        if (!is_user_logged_in()) {
            return '<p>' . __('Please log in to access the creator dashboard.', 'opencontext-wp') . '</p>';
        }
        
        return '<div id="opencontext-creator-dashboard"></div>';
    }
    
    public function handle_auth() {
        check_ajax_referer('opencontext_nonce', 'nonce');
        
        $wallet_address = sanitize_text_field($_POST['wallet_address']);
        $passport_id = sanitize_text_field($_POST['passport_id']);
        
        if (is_user_logged_in()) {
            $user_id = get_current_user_id();
            update_user_meta($user_id, '_opencontext_wallet', $wallet_address);
            update_user_meta($user_id, '_opencontext_passport', $passport_id);
        }
        
        wp_send_json_success(array(
            'message' => __('Wallet connected successfully', 'opencontext-wp')
        ));
    }
    
    public function handle_stream_pay() {
        check_ajax_referer('opencontext_nonce', 'nonce');
        
        $author_wallet = sanitize_text_field($_POST['author_wallet']);
        $rate = floatval($_POST['rate']);
        $post_id = intval($_POST['post_id']);
        
        wp_send_json_success(array(
            'message' => __('Payment stream initiated', 'opencontext-wp'),
            'post_id' => $post_id
        ));
    }
    
    public function add_meta_tags() {
        if (is_singular('post')) {
            $post_id = get_the_ID();
            $is_premium = get_post_meta($post_id, '_opencontext_premium', true);
            
            if ($is_premium) {
                echo '<meta name="opencontext:premium" content="true">' . "\n";
                echo '<meta name="opencontext:rate" content="' . esc_attr(get_post_meta($post_id, '_opencontext_payment_rate', true)) . '">' . "\n";
            }
        }
    }
    
    public function admin_page() {
        include OPENCONTEXT_PLUGIN_DIR . 'includes/admin-page.php';
    }
    
    public function settings_page() {
        include OPENCONTEXT_PLUGIN_DIR . 'includes/settings-page.php';
    }
    
    public function dashboard_page() {
        include OPENCONTEXT_PLUGIN_DIR . 'includes/dashboard-page.php';
    }
    
    public function activate() {
        add_option('opencontext_rpc_url', 'https://sepolia.era.zksync.dev');
        add_option('opencontext_gateway_url', 'https://gateway.opencontext.network');
        flush_rewrite_rules();
    }
    
    public function deactivate() {
        flush_rewrite_rules();
    }
}

new OpenContextWP();