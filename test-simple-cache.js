
import fetch from 'node-fetch';

async function testSimpleCache() {
    const url = 'http://localhost:4000/api/chat';
    const pageUrl = "https://example.com/simple-test-form";

    // 1. Setup Cache with specific fields
    const setupPayload = {
        page_url: pageUrl,
        fields: [
            { label: "First Name", input_type: "text", selector_id: "fname" },
            { label: "Full Name", input_type: "text", selector_id: "fullname" },
            { label: "Gender", input_type: "select", options: ["Male", "Female", "Other"], selector_id: "gender" },
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

    // 2. Chat Request (simulating frontend)
    const chatPayload = {
        message: "fill this form",
        userId: "test-user-simple",
        pageUrl: pageUrl,
        fieldsMinimal: [
            { label: "First Name", selector_id: "fname" },
            { label: "Full Name", selector_id: "fullname" },
            { label: "Gender", selector_id: "gender" },
            { label: "Email", selector_id: "email" },
            { label: "Phone Number", selector_id: "phone" }
        ],
        userDocuments: [],
        userProfile: {
            "First Name": "Rahul",
            "Full Name": "Rahul Sharma",
            "Gender": "Male",
            "Email": "rahul@example.com",
            "Phone Number": "9876543210"
        }
    };

    try {
        console.log("2. Sending chat request...");
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chatPayload)
        });
        const data = await response.json();

        console.log("\nResponse Summary:");
        if (data.suggestedFills) {
            console.log(`Mapped ${data.suggestedFills.length} fields.`);
            data.suggestedFills.forEach(f => {
                console.log(` - ${f.label}: ${f.suggested_value}`);
            });
        } else {
            console.log("No suggested fills.");
        }

    } catch (error) {
        console.error("Error:", error);
    }
}

testSimpleCache();
