jQuery(document).ready(function($) {
    
    // Toggle premium settings visibility
    $('#opencontext_premium').change(function() {
        if ($(this).is(':checked')) {
            $('#premium-settings').slideDown();
        } else {
            $('#premium-settings').slideUp();
        }
    });
    
    // Use default rate button
    $('#use-default-rate').click(function() {
        var defaultRate = $(this).data('rate');
        $('#opencontext_payment_rate').val(defaultRate);
        updateShortcode();
    });
    
    // Update shortcode when rate changes
    $('#opencontext_payment_rate').on('input', function() {
        updateShortcode();
    });
    
    // Copy shortcode to clipboard
    $('#copy-shortcode').click(function() {
        var shortcode = $(this).prev('code').text();
        
        // Create temporary textarea to copy text
        var temp = $('<textarea>');
        $('body').append(temp);
        temp.val(shortcode).select();
        document.execCommand('copy');
        temp.remove();
        
        // Show feedback
        var originalText = $(this).text();
        $(this).text('Copied!').prop('disabled', true);
        
        setTimeout(() => {
            $(this).text(originalText).prop('disabled', false);
        }, 2000);
    });
    
    function updateShortcode() {
        var rate = $('#opencontext_payment_rate').val() || '0.01';
        $('#shortcode-rate').text(rate);
    }
    
    // Initialize shortcode display
    updateShortcode();
});