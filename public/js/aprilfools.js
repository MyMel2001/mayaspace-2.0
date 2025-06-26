document.addEventListener('DOMContentLoaded', function() {
    try {
        const today = new Date();
        // April is month 3 (0-indexed)
        if (today.getMonth() === 3 && today.getDate() === 1) {
            // Change logo
            const logo = document.getElementById('site-logo');
            if (logo) {
                logo.src = '/logos/april-fools.png';
                logo.alt = 'PapiSpace Logo';
            }

            // Function to replace text in all text nodes
            function replaceText(node) {
                if (node.nodeType === Node.TEXT_NODE) {
                    if (node.nodeValue.includes('MayaSpace')) {
                        node.nodeValue = node.nodeValue.replace(/MayaSpace/g, 'PapiSpace');
                    }
                } else {
                    for (let i = 0; i < node.childNodes.length; i++) {
                        replaceText(node.childNodes[i]);
                    }
                }
            }
            
            // Replace text in body and title
            replaceText(document.body);
            document.title = document.title.replace(/MayaSpace/g, 'PapiSpace');
        }
    } catch (e) {
        console.error("April Fools script failed:", e);
    }
}); 