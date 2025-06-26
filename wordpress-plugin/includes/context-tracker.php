<?php
if (!defined('ABSPATH')) {
    exit;
}

class OpenContextTracker {
    
    public function __construct() {
        add_action('wp_footer', array($this, 'add_tracking_script'));
        add_action('wp_ajax_opencontext_track', array($this, 'handle_tracking'));
        add_action('wp_ajax_nopriv_opencontext_track', array($this, 'handle_tracking'));
        add_action('wp_ajax_opencontext_get_recommendations', array($this, 'get_recommendations'));
        add_action('wp_ajax_nopriv_opencontext_get_recommendations', array($this, 'get_recommendations'));
        
        // Add tracking hooks
        add_action('wp_head', array($this, 'add_tracking_meta'));
        add_filter('the_content', array($this, 'add_tracking_attributes'));
    }
    
    public function add_tracking_meta() {
        if (is_singular('post')) {
            $post_id = get_the_ID();
            $post_data = array(
                'id' => $post_id,
                'title' => get_the_title(),
                'author' => get_the_author(),
                'categories' => wp_get_post_categories($post_id, array('fields' => 'names')),
                'tags' => wp_get_post_tags($post_id, array('fields' => 'names')),
                'word_count' => str_word_count(strip_tags(get_the_content())),
                'published' => get_the_date('c')
            );
            
            echo '<script>window.openContextPostData = ' . json_encode($post_data) . ';</script>' . "\n";
        }
    }
    
    public function add_tracking_attributes($content) {
        if (is_singular('post') && in_the_loop() && is_main_query()) {
            $post_id = get_the_ID();
            $content = '<div class="opencontext-tracked-content" data-post-id="' . $post_id . '">' . $content . '</div>';
        }
        return $content;
    }
    
    public function add_tracking_script() {
        if (!is_singular('post')) {
            return;
        }
        
        $enable_tracking = get_option('opencontext_enable_context_tracking', '1');
        if ($enable_tracking !== '1') {
            return;
        }
        
        // Only load tracking for users with wallets connected to reduce overhead
        if (!$this->should_load_tracking()) {
            return;
        }
        
        ?>
        <script>
        document.addEventListener('DOMContentLoaded', function() {
            if (typeof window.OpenContextTracker !== 'undefined' && window.openContextPostData) {
                // Track initial page view
                window.OpenContextTracker.trackView(
                    window.openContextPostData.id,
                    window.openContextPostData.title,
                    window.openContextPostData.author
                );
                
                // Enhanced tracking for user engagement
                OpenContextEnhancedTracker.init(window.openContextPostData);
            }
        });
        
        class OpenContextEnhancedTracker {
            static init(postData) {
                this.postData = postData;
                this.startTime = Date.now();
                this.scrollDepth = 0;
                this.timeOnPage = 0;
                this.interactions = [];
                
                this.setupScrollTracking();
                this.setupTimeTracking();
                this.setupInteractionTracking();
                this.setupExitTracking();
            }
            
            static setupScrollTracking() {
                let maxScroll = 0;
                const contentElement = document.querySelector('.opencontext-tracked-content');
                
                if (!contentElement) return;
                
                const observer = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        if (entry.isIntersecting) {
                            const scrollPercent = Math.round((window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100);
                            if (scrollPercent > maxScroll) {
                                maxScroll = scrollPercent;
                                this.scrollDepth = scrollPercent;
                                
                                // Track milestone scroll depths
                                if ([25, 50, 75, 90].includes(scrollPercent)) {
                                    this.trackEvent('scroll_depth', { depth: scrollPercent });
                                }
                            }
                        }
                    });
                }, { threshold: 0.1 });
                
                observer.observe(contentElement);
            }
            
            static setupTimeTracking() {
                // Track time spent reading
                let isVisible = true;
                
                document.addEventListener('visibilitychange', () => {
                    if (document.hidden) {
                        isVisible = false;
                        this.timeOnPage = Date.now() - this.startTime;
                    } else {
                        isVisible = true;
                        this.startTime = Date.now();
                    }
                });
                
                // Track reading time milestones
                setInterval(() => {
                    if (isVisible) {
                        const currentTime = Date.now() - this.startTime;
                        const totalTime = this.timeOnPage + currentTime;
                        
                        // Track at 30s, 1min, 2min, 5min intervals
                        const milestones = [30000, 60000, 120000, 300000];
                        milestones.forEach(milestone => {
                            if (totalTime >= milestone && !this.interactions.includes('time_' + milestone)) {
                                this.trackEvent('reading_time', { duration: milestone });
                                this.interactions.push('time_' + milestone);
                            }
                        });
                    }
                }, 5000);
            }
            
            static setupInteractionTracking() {
                // Track text selection
                document.addEventListener('selectstart', () => {
                    document.addEventListener('selectionchange', this.handleTextSelection.bind(this), { once: true });
                });
                
                // Track link clicks within content
                document.querySelectorAll('.opencontext-tracked-content a').forEach(link => {
                    link.addEventListener('click', (e) => {
                        this.trackEvent('link_click', {
                            url: link.href,
                            text: link.textContent.trim()
                        });
                    });
                });
                
                // Track copy events
                document.addEventListener('copy', () => {
                    this.trackEvent('content_copy', {
                        selection: window.getSelection().toString().substring(0, 100)
                    });
                });
            }
            
            static handleTextSelection() {
                const selection = window.getSelection();
                if (selection.rangeCount > 0 && selection.toString().length > 10) {
                    this.trackEvent('text_selection', {
                        text: selection.toString().substring(0, 100),
                        length: selection.toString().length
                    });
                }
            }
            
            static setupExitTracking() {
                window.addEventListener('beforeunload', () => {
                    this.timeOnPage += Date.now() - this.startTime;
                    
                    // Send final engagement data
                    this.trackEvent('page_exit', {
                        totalTime: this.timeOnPage,
                        scrollDepth: this.scrollDepth,
                        interactions: this.interactions.length
                    });
                });
            }
            
            static trackEvent(event, data) {
                if (typeof window.OpenContextTracker !== 'undefined') {
                    window.OpenContextTracker.trackEngagement(this.postData.id, event, data);
                }
            }
        }
        
        // Load personalized recommendations (lazy load after 3 seconds to avoid blocking)
        if (typeof window.openContextWP !== 'undefined' && window.openContextWP.wallet) {
            setTimeout(() => {
                OpenContextRecommendations.load();
            }, 3000);
        }
        
        class OpenContextRecommendations {
            static async load() {
                try {
                    const response = await fetch('<?php echo admin_url('admin-ajax.php'); ?>', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: new URLSearchParams({
                            action: 'opencontext_get_recommendations',
                            nonce: '<?php echo wp_create_nonce('opencontext_recommendations'); ?>',
                            post_id: window.openContextPostData.id,
                            wallet: window.openContextWP.wallet
                        })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success && result.data.recommendations) {
                        this.displayRecommendations(result.data.recommendations);
                    }
                    
                } catch (error) {
                    console.error('Failed to load recommendations:', error);
                }
            }
            
            static displayRecommendations(recommendations) {
                const container = document.querySelector('.opencontext-tracked-content');
                if (!container || recommendations.length === 0) return;
                
                const recDiv = document.createElement('div');
                recDiv.className = 'opencontext-recommendations';
                recDiv.innerHTML = `
                    <h3>Recommended for You</h3>
                    <div class="recommendations-grid">
                        ${recommendations.map(rec => `
                            <div class="recommendation-item">
                                <h4><a href="${rec.url}">${rec.title}</a></h4>
                                <p>${rec.excerpt}</p>
                                <div class="rec-meta">
                                    <span class="match-score">${Math.round(rec.score * 100)}% match</span>
                                    ${rec.premium ? '<span class="premium-badge">Premium</span>' : ''}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `;
                
                container.appendChild(recDiv);
            }
        }
        </script>
        
        <style>
        .opencontext-recommendations {
            margin: 40px 0;
            padding: 30px;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            border-radius: 12px;
            border-left: 4px solid #667eea;
        }
        
        .opencontext-recommendations h3 {
            margin: 0 0 20px 0;
            color: #2c3e50;
            font-size: 20px;
            font-weight: 600;
        }
        
        .recommendations-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
        }
        
        .recommendation-item {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            transition: transform 0.3s ease;
        }
        
        .recommendation-item:hover {
            transform: translateY(-2px);
        }
        
        .recommendation-item h4 {
            margin: 0 0 10px 0;
            font-size: 16px;
        }
        
        .recommendation-item a {
            color: #2c3e50;
            text-decoration: none;
        }
        
        .recommendation-item a:hover {
            color: #667eea;
        }
        
        .recommendation-item p {
            color: #6c757d;
            font-size: 14px;
            line-height: 1.5;
            margin: 0 0 15px 0;
        }
        
        .rec-meta {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 12px;
        }
        
        .match-score {
            color: #28a745;
            font-weight: 600;
        }
        
        .premium-badge {
            background: #667eea;
            color: white;
            padding: 2px 8px;
            border-radius: 12px;
            font-weight: 600;
        }
        </style>
        <?php
    }
    
    public function handle_tracking() {
        check_ajax_referer('opencontext_nonce', 'nonce');
        
        if (!isset($_POST['event']) || !isset($_POST['post_id'])) {
            wp_send_json_error('Missing required parameters');
        }
        
        try {
            $event = sanitize_text_field($_POST['event']);
            $post_id = intval($_POST['post_id']);
            $data = isset($_POST['data']) ? json_decode(stripslashes($_POST['data']), true) : array();
            $wallet = isset($_POST['wallet']) ? sanitize_text_field($_POST['wallet']) : '';
            
            // Validate inputs
            if (!in_array($event, array('view', 'scroll_depth', 'reading_time', 'text_selection', 'link_click', 'content_copy', 'page_exit', 'premium_access'))) {
                throw new Exception('Invalid event type');
            }
            
            if (!get_post($post_id)) {
                throw new Exception('Invalid post ID');
            }
            
            // Rate limit tracking requests - max 50 per minute per IP
            $ip = $_SERVER['REMOTE_ADDR'];
            $rate_key = 'opencontext_tracking_rate_' . $ip;
            $current_count = get_transient($rate_key) ?: 0;
            
            if ($current_count >= 50) {
                wp_send_json_error('Rate limit exceeded');
            }
            
            set_transient($rate_key, $current_count + 1, 60);
            
            // Store tracking data with size limits
            $tracking_data = array(
                'event' => $event,
                'post_id' => $post_id,
                'data' => array_slice($data, 0, 10), // Limit data size
                'wallet' => $wallet,
                'timestamp' => current_time('mysql'),
                'ip' => $ip
            );
            
            // Store in transients with cleanup
            $transient_key = 'opencontext_tracking_' . $post_id;
            $existing_data = get_transient($transient_key) ?: array();
            
            // Keep only last 100 entries per post to prevent memory issues
            if (count($existing_data) >= 100) {
                $existing_data = array_slice($existing_data, -50);
            }
            
            $existing_data[] = $tracking_data;
            set_transient($transient_key, $existing_data, 2 * HOUR_IN_SECONDS);
            
            wp_send_json_success(array(
                'message' => 'Tracking data recorded',
                'event' => $event
            ));
            
        } catch (Exception $e) {
            wp_send_json_error($e->getMessage());
        }
    }
    
    public function get_recommendations() {
        check_ajax_referer('opencontext_recommendations', 'nonce');
        
        $post_id = intval($_POST['post_id']);
        $wallet = sanitize_text_field($_POST['wallet']);
        
        // Get user's reading history from tracking data
        $user_interests = $this->analyze_user_interests($wallet);
        $current_post = get_post($post_id);
        
        // Generate recommendations based on content similarity and user interests
        $recommendations = $this->generate_recommendations($current_post, $user_interests);
        
        wp_send_json_success(array(
            'recommendations' => $recommendations,
            'user_interests' => $user_interests
        ));
    }
    
    private function analyze_user_interests($wallet) {
        // Analyze user's reading patterns
        $interests = array();
        
        // Get recent posts the user has interacted with
        $recent_posts = get_posts(array(
            'posts_per_page' => 20,
            'post_status' => 'publish'
        ));
        
        foreach ($recent_posts as $post) {
            $tracking_data = get_transient('opencontext_tracking_' . $post->ID) ?: array();
            
            foreach ($tracking_data as $data) {
                if ($data['wallet'] === $wallet) {
                    // Weight different events
                    $weight = 1;
                    switch ($data['event']) {
                        case 'view': $weight = 1; break;
                        case 'scroll_depth': $weight = 2; break;
                        case 'reading_time': $weight = 3; break;
                        case 'text_selection': $weight = 4; break;
                        case 'premium_access': $weight = 5; break;
                    }
                    
                    // Extract categories and tags
                    $categories = wp_get_post_categories($post->ID, array('fields' => 'names'));
                    $tags = wp_get_post_tags($post->ID, array('fields' => 'names'));
                    
                    foreach ($categories as $category) {
                        $interests[$category] = ($interests[$category] ?? 0) + $weight;
                    }
                    
                    foreach ($tags as $tag) {
                        $interests[$tag] = ($interests[$tag] ?? 0) + $weight;
                    }
                }
            }
        }
        
        // Sort by interest level
        arsort($interests);
        
        return array_slice($interests, 0, 10, true);
    }
    
    private function generate_recommendations($current_post, $user_interests) {
        $recommendations = array();
        
        // Get current post categories/tags
        $current_categories = wp_get_post_categories($current_post->ID, array('fields' => 'names'));
        $current_tags = wp_get_post_tags($current_post->ID, array('fields' => 'names'));
        
        // Find related posts
        $related_posts = get_posts(array(
            'posts_per_page' => 10,
            'post_status' => 'publish',
            'post__not_in' => array($current_post->ID),
            'category__in' => wp_get_post_categories($current_post->ID),
            'orderby' => 'rand'
        ));
        
        foreach ($related_posts as $post) {
            $score = 0;
            
            // Calculate relevance score
            $post_categories = wp_get_post_categories($post->ID, array('fields' => 'names'));
            $post_tags = wp_get_post_tags($post->ID, array('fields' => 'names'));
            
            // Score based on category overlap
            foreach ($post_categories as $category) {
                if (in_array($category, $current_categories)) {
                    $score += 0.3;
                }
                if (isset($user_interests[$category])) {
                    $score += ($user_interests[$category] / 100);
                }
            }
            
            // Score based on tag overlap
            foreach ($post_tags as $tag) {
                if (in_array($tag, $current_tags)) {
                    $score += 0.2;
                }
                if (isset($user_interests[$tag])) {
                    $score += ($user_interests[$tag] / 100);
                }
            }
            
            if ($score > 0.1) {
                $is_premium = get_post_meta($post->ID, '_opencontext_premium', true);
                
                $recommendations[] = array(
                    'id' => $post->ID,
                    'title' => $post->post_title,
                    'excerpt' => wp_trim_words($post->post_excerpt ?: $post->post_content, 20),
                    'url' => get_permalink($post->ID),
                    'score' => min($score, 1.0),
                    'premium' => $is_premium === '1',
                    'categories' => $post_categories,
                    'tags' => $post_tags
                );
            }
        }
        
        // Sort by score and return top 3
        usort($recommendations, function($a, $b) {
            return $b['score'] <=> $a['score'];
        });
        
        return array_slice($recommendations, 0, 3);
    }
    
    private function should_load_tracking() {
        // Only load heavy tracking scripts if user likely has wallet or is logged in
        if (is_user_logged_in()) {
            $user_id = get_current_user_id();
            $wallet = get_user_meta($user_id, '_opencontext_wallet', true);
            if ($wallet) {
                return true;
            }
        }
        
        // Check if user has interacted with OpenContext before (stored in cookie/localStorage)
        if (isset($_COOKIE['opencontext_wallet']) || isset($_GET['wallet'])) {
            return true;
        }
        
        // For first-time visitors, load lightweight tracking only
        return false;
    }
}

new OpenContextTracker();