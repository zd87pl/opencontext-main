<?php
/**
 * OAuth Integration for OpenContext WordPress Plugin
 * Enables seamless authentication with OpenContext backend
 */

if (!defined('ABSPATH')) {
    exit;
}

class OpenContextOAuth {
    
    private $backend_url;
    private $client_id;
    private $client_secret;
    
    public function __construct() {
        $this->backend_url = get_option('opencontext_backend_url', 'https://api.opencontext.network');
        $this->client_id = get_option('opencontext_oauth_client_id', '');
        $this->client_secret = get_option('opencontext_oauth_client_secret', '');
        
        add_action('init', array($this, 'init'));
        add_action('wp_ajax_opencontext_oauth_connect', array($this, 'handle_oauth_connect'));
        add_action('wp_ajax_opencontext_oauth_callback', array($this, 'handle_oauth_callback'));
        add_action('wp_ajax_opencontext_sync_content', array($this, 'handle_content_sync'));
        add_action('wp_enqueue_scripts', array($this, 'enqueue_oauth_scripts'));
        add_filter('query_vars', array($this, 'add_query_vars'));
        add_action('template_redirect', array($this, 'handle_oauth_redirect'));
    }
    
    public function init() {
        // Register OAuth endpoint
        add_rewrite_rule(
            '^opencontext/oauth/callback/?$',
            'index.php?opencontext_oauth_callback=1',
            'top'
        );
    }
    
    public function add_query_vars($vars) {
        $vars[] = 'opencontext_oauth_callback';
        return $vars;
    }
    
    public function enqueue_oauth_scripts() {
        wp_enqueue_script(
            'opencontext-oauth',
            OPENCONTEXT_PLUGIN_URL . 'assets/js/oauth-integration.js',
            array('jquery'),
            OPENCONTEXT_VERSION,
            true
        );
        
        wp_localize_script('opencontext-oauth', 'opencontext_oauth', array(
            'ajax_url' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce('opencontext_oauth_nonce'),
            'backend_url' => $this->backend_url,
            'redirect_uri' => home_url('/opencontext/oauth/callback/'),
            'client_id' => $this->client_id
        ));
    }
    
    /**
     * Handle OAuth connection request
     */
    public function handle_oauth_connect() {
        check_ajax_referer('opencontext_oauth_nonce', 'nonce');
        
        if (!is_user_logged_in()) {
            wp_send_json_error(__('User must be logged in to connect OAuth', 'opencontext-wp'));
        }
        
        try {
            $provider = sanitize_text_field($_POST['provider']);
            $allowed_providers = array('google', 'github', 'medium', 'wordpress');
            
            if (!in_array($provider, $allowed_providers)) {
                throw new Exception(__('Invalid OAuth provider', 'opencontext-wp'));
            }
            
            // Generate state parameter for security
            $state = wp_generate_password(32, false);
            $user_id = get_current_user_id();
            
            // Store state in user meta temporarily
            update_user_meta($user_id, '_opencontext_oauth_state', $state);
            update_user_meta($user_id, '_opencontext_oauth_provider', $provider);
            
            // Build OAuth URL
            $oauth_url = $this->build_oauth_url($provider, $state);
            
            wp_send_json_success(array(
                'oauth_url' => $oauth_url,
                'provider' => $provider
            ));
            
        } catch (Exception $e) {
            wp_send_json_error($e->getMessage());
        }
    }
    
    /**
     * Handle OAuth callback from our backend
     */
    public function handle_oauth_redirect() {
        if (!get_query_var('opencontext_oauth_callback')) {
            return;
        }
        
        try {
            $code = sanitize_text_field($_GET['code']);
            $state = sanitize_text_field($_GET['state']);
            $error = sanitize_text_field($_GET['error']);
            
            if ($error) {
                wp_die(__('OAuth authentication failed: ', 'opencontext-wp') . esc_html($error));
            }
            
            if (!$code || !$state) {
                wp_die(__('Invalid OAuth callback parameters', 'opencontext-wp'));
            }
            
            // Find user by state
            $users = get_users(array(
                'meta_key' => '_opencontext_oauth_state',
                'meta_value' => $state,
                'number' => 1
            ));
            
            if (empty($users)) {
                wp_die(__('Invalid OAuth state', 'opencontext-wp'));
            }
            
            $user = $users[0];
            $provider = get_user_meta($user->ID, '_opencontext_oauth_provider', true);
            
            // Exchange code for access token
            $token_data = $this->exchange_code_for_token($code, $provider);
            
            if (!$token_data) {
                wp_die(__('Failed to obtain access token', 'opencontext-wp'));
            }
            
            // Store OAuth data
            update_user_meta($user->ID, '_opencontext_oauth_token', $token_data['access_token']);
            update_user_meta($user->ID, '_opencontext_oauth_refresh_token', $token_data['refresh_token'] ?? '');
            update_user_meta($user->ID, '_opencontext_oauth_provider_verified', $provider);
            update_user_meta($user->ID, '_opencontext_oauth_connected_at', current_time('mysql'));
            
            // Clean up temporary data
            delete_user_meta($user->ID, '_opencontext_oauth_state');
            delete_user_meta($user->ID, '_opencontext_oauth_provider');
            
            // Log the user in if they weren't already
            wp_set_current_user($user->ID);
            wp_set_auth_cookie($user->ID);
            
            // Redirect to success page
            wp_redirect(admin_url('admin.php?page=opencontext-dashboard&oauth_connected=1'));
            exit;
            
        } catch (Exception $e) {
            wp_die(__('OAuth callback error: ', 'opencontext-wp') . esc_html($e->getMessage()));
        }
    }
    
    /**
     * Handle content synchronization from connected platforms
     */
    public function handle_content_sync() {
        check_ajax_referer('opencontext_oauth_nonce', 'nonce');
        
        if (!is_user_logged_in()) {
            wp_send_json_error(__('User must be logged in', 'opencontext-wp'));
        }
        
        try {
            $user_id = get_current_user_id();
            $provider = get_user_meta($user_id, '_opencontext_oauth_provider_verified', true);
            $access_token = get_user_meta($user_id, '_opencontext_oauth_token', true);
            
            if (!$provider || !$access_token) {
                throw new Exception(__('OAuth not configured', 'opencontext-wp'));
            }
            
            // Sync content based on provider
            $synced_content = array();
            
            switch ($provider) {
                case 'medium':
                    $synced_content = $this->sync_medium_content($access_token);
                    break;
                case 'github':
                    $synced_content = $this->sync_github_content($access_token);
                    break;
                case 'wordpress':
                    $synced_content = $this->sync_wordpress_content($access_token);
                    break;
                default:
                    throw new Exception(__('Content sync not supported for this provider', 'opencontext-wp'));
            }
            
            wp_send_json_success(array(
                'synced_count' => count($synced_content),
                'content' => $synced_content
            ));
            
        } catch (Exception $e) {
            wp_send_json_error($e->getMessage());
        }
    }
    
    private function build_oauth_url($provider, $state) {
        $redirect_uri = home_url('/opencontext/oauth/callback/');
        
        // Use our backend's OAuth endpoints
        $oauth_base_url = $this->backend_url . '/auth/' . $provider;
        
        $params = array(
            'client_id' => $this->client_id,
            'redirect_uri' => $redirect_uri,
            'state' => $state,
            'response_type' => 'code',
            'wordpress_user_id' => get_current_user_id() // Pass WP user ID for linking
        );
        
        // Provider-specific scopes
        switch ($provider) {
            case 'google':
                $params['scope'] = 'openid email profile';
                break;
            case 'github':
                $params['scope'] = 'read:user user:email repo';
                break;
            case 'medium':
                $params['scope'] = 'basicProfile listPublications uploadImage';
                break;
        }
        
        return $oauth_base_url . '?' . http_build_query($params);
    }
    
    private function exchange_code_for_token($code, $provider) {
        $url = $this->backend_url . '/auth/' . $provider . '/token';
        
        $response = wp_remote_post($url, array(
            'body' => array(
                'code' => $code,
                'client_id' => $this->client_id,
                'client_secret' => $this->client_secret,
                'redirect_uri' => home_url('/opencontext/oauth/callback/')
            ),
            'headers' => array(
                'Content-Type' => 'application/x-www-form-urlencoded'
            ),
            'timeout' => 30
        ));
        
        if (is_wp_error($response)) {
            throw new Exception('HTTP request failed: ' . $response->get_error_message());
        }
        
        $body = wp_remote_retrieve_body($response);
        $data = json_decode($body, true);
        
        if (!$data || isset($data['error'])) {
            throw new Exception('Token exchange failed: ' . ($data['error'] ?? 'Unknown error'));
        }
        
        return $data;
    }
    
    private function sync_medium_content($access_token) {
        // Call Medium API to get user's publications
        $medium_api_url = 'https://api.medium.com/v1/me/publications';
        
        $response = wp_remote_get($medium_api_url, array(
            'headers' => array(
                'Authorization' => 'Bearer ' . $access_token,
                'Content-Type' => 'application/json'
            )
        ));
        
        if (is_wp_error($response)) {
            throw new Exception('Failed to fetch Medium content');
        }
        
        $data = json_decode(wp_remote_retrieve_body($response), true);
        $synced_posts = array();
        
        if (isset($data['data'])) {
            foreach ($data['data'] as $publication) {
                // Create WordPress posts from Medium publications
                $post_data = array(
                    'post_title' => sanitize_text_field($publication['name']),
                    'post_content' => wp_kses_post($publication['description']),
                    'post_status' => 'draft',
                    'post_author' => get_current_user_id(),
                    'meta_input' => array(
                        '_opencontext_synced_from' => 'medium',
                        '_opencontext_external_id' => $publication['id'],
                        '_opencontext_premium' => true,
                        '_opencontext_payment_rate' => get_option('opencontext_default_payment_rate', '0.01')
                    )
                );
                
                $post_id = wp_insert_post($post_data);
                
                if ($post_id && !is_wp_error($post_id)) {
                    $synced_posts[] = array(
                        'id' => $post_id,
                        'title' => $publication['name'],
                        'source' => 'medium'
                    );
                }
            }
        }
        
        return $synced_posts;
    }
    
    private function sync_github_content($access_token) {
        // Sync GitHub repositories with documentation
        $github_api_url = 'https://api.github.com/user/repos';
        
        $response = wp_remote_get($github_api_url, array(
            'headers' => array(
                'Authorization' => 'token ' . $access_token,
                'User-Agent' => 'OpenContext-WordPress-Plugin'
            )
        ));
        
        if (is_wp_error($response)) {
            throw new Exception('Failed to fetch GitHub repositories');
        }
        
        $repos = json_decode(wp_remote_retrieve_body($response), true);
        $synced_posts = array();
        
        foreach ($repos as $repo) {
            if (!$repo['private'] && $repo['description']) {
                // Check for README
                $readme_url = 'https://api.github.com/repos/' . $repo['full_name'] . '/readme';
                $readme_response = wp_remote_get($readme_url, array(
                    'headers' => array(
                        'Authorization' => 'token ' . $access_token,
                        'User-Agent' => 'OpenContext-WordPress-Plugin'
                    )
                ));
                
                if (!is_wp_error($readme_response)) {
                    $readme_data = json_decode(wp_remote_retrieve_body($readme_response), true);
                    $readme_content = base64_decode($readme_data['content']);
                    
                    $post_data = array(
                        'post_title' => sanitize_text_field($repo['name']),
                        'post_content' => wp_kses_post($readme_content),
                        'post_excerpt' => sanitize_text_field($repo['description']),
                        'post_status' => 'draft',
                        'post_author' => get_current_user_id(),
                        'meta_input' => array(
                            '_opencontext_synced_from' => 'github',
                            '_opencontext_external_id' => $repo['id'],
                            '_opencontext_premium' => true,
                            '_opencontext_payment_rate' => get_option('opencontext_default_payment_rate', '0.01'),
                            '_opencontext_github_repo_url' => $repo['html_url']
                        )
                    );
                    
                    $post_id = wp_insert_post($post_data);
                    
                    if ($post_id && !is_wp_error($post_id)) {
                        $synced_posts[] = array(
                            'id' => $post_id,
                            'title' => $repo['name'],
                            'source' => 'github'
                        );
                    }
                }
            }
        }
        
        return $synced_posts;
    }
    
    private function sync_wordpress_content($access_token) {
        // For WordPress.com API integration
        $wp_api_url = 'https://public-api.wordpress.com/rest/v1.1/me/sites';
        
        $response = wp_remote_get($wp_api_url, array(
            'headers' => array(
                'Authorization' => 'Bearer ' . $access_token
            )
        ));
        
        if (is_wp_error($response)) {
            throw new Exception('Failed to fetch WordPress.com sites');
        }
        
        $data = json_decode(wp_remote_retrieve_body($response), true);
        $synced_posts = array();
        
        if (isset($data['sites'])) {
            foreach ($data['sites'] as $site) {
                // Get recent posts from each site
                $posts_url = 'https://public-api.wordpress.com/rest/v1.1/sites/' . $site['ID'] . '/posts';
                $posts_response = wp_remote_get($posts_url, array(
                    'headers' => array(
                        'Authorization' => 'Bearer ' . $access_token
                    )
                ));
                
                if (!is_wp_error($posts_response)) {
                    $posts_data = json_decode(wp_remote_retrieve_body($posts_response), true);
                    
                    if (isset($posts_data['posts'])) {
                        foreach (array_slice($posts_data['posts'], 0, 5) as $post) { // Limit to 5 recent posts
                            $post_data = array(
                                'post_title' => sanitize_text_field($post['title']),
                                'post_content' => wp_kses_post($post['content']),
                                'post_excerpt' => sanitize_text_field($post['excerpt']),
                                'post_status' => 'draft',
                                'post_author' => get_current_user_id(),
                                'meta_input' => array(
                                    '_opencontext_synced_from' => 'wordpress',
                                    '_opencontext_external_id' => $post['ID'],
                                    '_opencontext_premium' => true,
                                    '_opencontext_payment_rate' => get_option('opencontext_default_payment_rate', '0.01'),
                                    '_opencontext_source_site' => $site['name']
                                )
                            );
                            
                            $post_id = wp_insert_post($post_data);
                            
                            if ($post_id && !is_wp_error($post_id)) {
                                $synced_posts[] = array(
                                    'id' => $post_id,
                                    'title' => $post['title'],
                                    'source' => 'wordpress'
                                );
                            }
                        }
                    }
                }
            }
        }
        
        return $synced_posts;
    }
    
    /**
     * Get OAuth connection status for current user
     */
    public function get_oauth_status() {
        if (!is_user_logged_in()) {
            return false;
        }
        
        $user_id = get_current_user_id();
        $provider = get_user_meta($user_id, '_opencontext_oauth_provider_verified', true);
        $connected_at = get_user_meta($user_id, '_opencontext_oauth_connected_at', true);
        
        if ($provider && $connected_at) {
            return array(
                'connected' => true,
                'provider' => $provider,
                'connected_at' => $connected_at
            );
        }
        
        return array('connected' => false);
    }
    
    /**
     * Disconnect OAuth for current user
     */
    public function disconnect_oauth() {
        if (!is_user_logged_in()) {
            return false;
        }
        
        $user_id = get_current_user_id();
        
        delete_user_meta($user_id, '_opencontext_oauth_token');
        delete_user_meta($user_id, '_opencontext_oauth_refresh_token');
        delete_user_meta($user_id, '_opencontext_oauth_provider_verified');
        delete_user_meta($user_id, '_opencontext_oauth_connected_at');
        
        return true;
    }
}

// Initialize OAuth integration
new OpenContextOAuth();