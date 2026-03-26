
import fetch from 'node-fetch';

async function testTargetedCache() {
    const url = 'http://localhost:4000/api/chat';
    const pageUrl = "https://example.com/targeted-test-form";

    // 1. Setup Cache
    const setupPayload = {
        page_url: pageUrl,
        fields: [
            { label: "First Name", input_type: "text", selector_id: "fname" },
            { label: "Last Name", input_type: "text", selector_id: "lname" },
            { label: "Email", input_type: "email", selector_id: "email" },
            { label: "Phone Number", input_type: "tel", selector_id: "phone" }
        ]
    };

    console.log("1. Setting up cache...");
    await fetch('http://localhost:4000/api/auto-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setupPayload)
    });

    const userProfile = {
        "First Name": "Rahul",
        "Last Name": "Sharma",
        "Email": "rahul@example.com",
        "Phone Number": "9876543210"
    };

    // Helper function to run chat test
    async function runChat(message, expectedCount) {
        console.log(`\nTesting message: "${message}"`);
        const chatPayload = {
            message: message,
            userId: "test-user-targeted",
            pageUrl: pageUrl,
            fieldsMinimal: [], // Simulate frontend sending nothing, relying on cache
            userDocuments: [],
            userProfile: userProfile
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(chatPayload)
            });
            const data = await response.json();

            if (data.suggestedFills) {
                console.log(`Mapped ${data.suggestedFills.length} fields. (Expected: ${expectedCount})`);
                data.suggestedFills.forEach(f => console.log(` - ${f.label}: ${f.suggested_value}`));

                if (data.suggestedFills.length === expectedCount) {
                    console.log("✅ PASS");
                } else {
                    console.log("❌ FAIL");
                }
            } else {
                console.log("No suggested fills.");
            }
        } catch (error) {
            console.error("Error:", error);
        }
    }

    // 2. Run Tests
    await runChat("fill first name", 1);
    await runChat("fill email and phone number", 2);
    await runChat("fill the form", 4);
}

testTargetedCache();
