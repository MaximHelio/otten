// Cloudflare Worker - Groq API with Auto Model Fallback
export default {
  async fetch(request, env) {
    // CORS 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // 1. Request 파싱
      console.log('[DEBUG] Parsing request body...');
      let requestBody;
      try {
        requestBody = await request.json();
        console.log('[DEBUG] Request parsed successfully');
        console.log('[DEBUG] Messages count:', requestBody.messages?.length);
        console.log('[DEBUG] System prompt length:', requestBody.system?.length);
      } catch (parseError) {
        console.error('[ERROR] Failed to parse request:', parseError);
        return new Response(JSON.stringify({ 
          error: 'Invalid JSON in request',
          details: parseError.message 
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      const { messages, system } = requestBody;

      // 2. API Key 체크
      console.log('[DEBUG] Checking API key...');
      if (!env.GROQ_API_KEY) {
        console.error('[ERROR] GROQ_API_KEY is not set');
        return new Response(JSON.stringify({ 
          error: 'API key not configured',
          details: 'GROQ_API_KEY environment variable is missing'
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      console.log('[DEBUG] API key found (length:', env.GROQ_API_KEY.length, ')');

      // 3. 모델 우선순위 리스트 (위에서부터 시도)
      const modelPriority = [
        'llama-3.1-8b-instant',        // 가장 빠르고 효율적 (기본)
        'gemma2-9b-it',                // Google Gemma 모델 (fallback 1)
        'mixtral-8x7b-32768',          // Mixtral 모델 (fallback 2)
      ];

      let lastError = null;
      
      // 4. 모델 순서대로 시도
      for (let i = 0; i < modelPriority.length; i++) {
        const currentModel = modelPriority[i];
        console.log(`[DEBUG] Trying model ${i + 1}/${modelPriority.length}: ${currentModel}`);

        const groqPayload = {
          model: currentModel,
          messages: [
            { role: 'system', content: system },
            ...messages
          ],
          temperature: 0.7,
          max_tokens: 1200
        };

        console.log('[DEBUG] Groq API payload prepared');
        console.log('[DEBUG] Total messages:', groqPayload.messages.length);

        try {
          // Groq API 호출
          console.log('[DEBUG] Calling Groq API...');
          const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${env.GROQ_API_KEY}`
            },
            body: JSON.stringify(groqPayload)
          });

          console.log('[DEBUG] Groq API response status:', response.status);
          console.log('[DEBUG] Groq API response statusText:', response.statusText);

          // Rate limit (429) 에러면 다음 모델 시도
          if (response.status === 429) {
            const errorText = await response.text();
            console.log(`[WARNING] Rate limit hit for ${currentModel}, trying next model...`);
            lastError = {
              model: currentModel,
              status: 429,
              details: errorText
            };
            continue; // 다음 모델로
          }

          // 다른 에러면 사용자 친화적 메시지로 변환
          if (!response.ok) {
            const errorText = await response.text();
            console.error('[ERROR] Groq API error response:', errorText);
            
            let errorDetails;
            try {
              errorDetails = JSON.parse(errorText);
            } catch {
              errorDetails = { raw: errorText };
            }

            // 사용자 친화적인 영어 에러 메시지 생성
            let userFriendlyMessage = '';
            
            if (response.status === 401) {
              // API 키 오류
              userFriendlyMessage = "I'm sorry, but there's an API authentication issue. Please contact the administrator at h.koh@wisc.edu";
            } else if (response.status === 400) {
              // 잘못된 요청 (모델 deprecated 등)
              userFriendlyMessage = "I'm sorry, but there's a system configuration issue. Please contact the administrator at h.koh@wisc.edu";
            } else if (response.status === 403) {
              // 권한 없음
              userFriendlyMessage = "I'm sorry, but there's an API permission issue. Please contact the administrator at h.koh@wisc.edu";
            } else if (response.status === 500 || response.status === 502 || response.status === 503) {
              // 서버 에러
              userFriendlyMessage = "I'm sorry, but the AI service is temporarily unavailable. Please try again in a moment.";
            } else {
              // 기타 에러
              userFriendlyMessage = "I'm sorry, but an unexpected issue occurred. Please try again in a moment.";
            }

            // 에러를 정상 응답처럼 반환
            return new Response(JSON.stringify({ 
              content: [{
                type: 'text',
                text: userFriendlyMessage
              }],
              _error: true, // 내부적으로 에러임을 표시
              _details: {
                status: response.status,
                statusText: response.statusText,
                details: errorDetails
              }
            }), {
              status: 200, // 200으로 반환
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }

          // 성공! 응답 파싱
          console.log('[DEBUG] Parsing Groq API response...');
          let data;
          try {
            data = await response.json();
            console.log('[DEBUG] Response parsed successfully');
            console.log('[DEBUG] Response has choices:', !!data.choices);
            console.log('[DEBUG] Choices length:', data.choices?.length);
            console.log(`[SUCCESS] Used model: ${currentModel}`);
          } catch (parseError) {
            console.error('[ERROR] Failed to parse Groq response:', parseError);
            const rawResponse = await response.text();
            console.error('[ERROR] Raw response:', rawResponse);
            return new Response(JSON.stringify({ 
              error: 'Failed to parse Groq response',
              details: parseError.message,
              raw: rawResponse
            }), {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }

          // 응답 검증
          if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            console.error('[ERROR] Invalid response structure:', JSON.stringify(data));
            return new Response(JSON.stringify({ 
              error: 'Invalid Groq response structure',
              details: 'Missing choices or message',
              response: data
            }), {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }

          // Anthropic 형식으로 변환
          const formattedResponse = {
            content: [{
              type: 'text',
              text: data.choices[0].message.content
            }],
            model_used: currentModel // 어떤 모델 사용했는지 표시
          };

          console.log('[DEBUG] Response formatted successfully');
          console.log('[DEBUG] Response text length:', formattedResponse.content[0].text.length);

          return new Response(JSON.stringify(formattedResponse), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });

        } catch (fetchError) {
          console.error(`[ERROR] Failed to fetch with ${currentModel}:`, fetchError);
          lastError = {
            model: currentModel,
            error: fetchError.message
          };
          continue; // 다음 모델로
        }
      }

      // 모든 모델이 실패한 경우
      console.error('[ERROR] All models failed');
      
      // 사용자 친화적인 영어 에러 메시지 생성
      let userFriendlyMessage = '';
      
      if (lastError && lastError.status === 429) {
        // Rate limit 에러
        userFriendlyMessage = "I'm sorry, but I've reached my daily usage limit and can't generate a response right now. Please try again later or contact Haejung Koh at h.koh@wisc.edu if this issue persists.";
      } else {
        // 기타 에러
        userFriendlyMessage = "I'm sorry, but I'm experiencing a temporary issue and can't respond right now. Please try again in a moment.";
      }
      
      // Anthropic 응답 형식으로 에러를 답변처럼 반환
      return new Response(JSON.stringify({ 
        content: [{
          type: 'text',
          text: userFriendlyMessage
        }],
        _error: true, // 내부적으로 에러임을 표시
        _details: {
          error: 'All models exhausted',
          lastError: lastError,
          triedModels: modelPriority
        }
      }), {
        status: 200, // 200으로 반환해서 UI에서 정상 메시지처럼 표시
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });

    } catch (error) {
      // 최상위 에러 핸들러
      console.error('[ERROR] Unexpected error:', error);
      console.error('[ERROR] Error name:', error.name);
      console.error('[ERROR] Error message:', error.message);
      console.error('[ERROR] Error stack:', error.stack);
      
      // 사용자 친화적 메시지로 반환
      return new Response(JSON.stringify({ 
        content: [{
          type: 'text',
          text: "I'm sorry, but an unexpected server error occurred. Please try again in a moment, or contact Haejung Koh at h.koh@wisc.edu if the issue persists."
        }],
        _error: true,
        _details: {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};