
import fetch from 'node-fetch';

async function testCachedFields() {
    const url = 'http://localhost:4000/api/chat';

    // 1. First, ensure there is a cache for this URL (using auto-map)
    const pageUrl = "https://example.com/cached-test-form";
    const setupPayload = {
        page_url: pageUrl,
        fields: [
            { label: "Cached Question 1", input_type: "text", selector_id: "q1" },
            { label: "Cached Question 2", input_type: "text", selector_id: "q2" }
        ]
    };

    console.log("1. Setting up cache...");
    await fetch('http://localhost:4000/api/auto-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setupPayload)
    });

    // 2. Now call chat with minimal fields (simulating frontend sending less info)
    // But we expect the backend to pick up the "Cached Question 1" label from DB
    const chatPayload = {
        message: "fill this form",
        userId: "test-user",
        pageUrl: pageUrl,
        fieldsMinimal: [
            { label: "Minimal Label 1", selector_id: "q1" }, // Different label to prove cache usage? 
            // Actually, if we use cache, we use the cached objects.
            // The cached object for q1 has label "Cached Question 1".
        ],
        userDocuments: [], // No docs, just testing field resolution flow
        userProfile: { "Cached Question 1": "Answer 1", "Cached Question 2": "Answer 2" }
    };

    try {
        console.log("2. Sending chat request...");
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chatPayload)
        });
        const data = await response.json();
        console.log("Response:", JSON.stringify(data, null, 2));

        // Verification logic
        if (data.suggestedFills && data.suggestedFills.length > 0) {
            const filledField = data.suggestedFills.find(f => f.selector_id === 'q1');
            if (filledField) {
                console.log(`Filled Field Label: "${filledField.label}"`);
                if (filledField.label === "Cached Question 1") {
                    console.log("✅ SUCCESS: Used cached label!");
                } else {
                    console.log("❌ FAILURE: Used minimal label (or other).");
                }
            }
        }

    } catch (error) {
        console.error("Error:", error);
    }
}

testCachedFields();
