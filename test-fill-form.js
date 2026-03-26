
import fetch from 'node-fetch';

async function testFillForm() {
    const url = 'http://localhost:4000/api/chat';
    // Mocking a list of fields similar to the user's form
    const fieldsMinimal = Array.from({ length: 28 }, (_, i) => ({
        label: `Field ${i}`,
        input_type: "text"
    }));

    const payload = {
        message: "fill this form",
        userId: "test-user",
        fieldsMinimal: fieldsMinimal,
        userDocuments: [
            {
                documentType: "Mock Doc",
                extractedData: {
                    "Field 0": "Value 0",
                    "Field 1": "Value 1",
                    "Field 2": "Value 2"
                }
            }
        ],
        userProfile: {
            "Field 0": "Value 0",
            "Field 1": "Value 1",
            "Field 2": "Value 2"
        }
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        console.log(`Message: "${payload.message}"`);
        console.log(`Suggested Fills Count: ${data.suggestedFills ? data.suggestedFills.length : 0}`);

        if (data.suggestedFills && data.suggestedFills.length > 0) {
            console.log("✅ SUCCESS: Got fills (Revert successful).");
        } else {
            console.log("❌ FAILURE: Still getting 0 fills.");
        }

    } catch (error) {
        console.error("Error:", error);
    }
}

testFillForm();
