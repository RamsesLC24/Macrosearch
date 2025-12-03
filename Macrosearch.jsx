import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, query, addDoc, serverTimestamp, orderBy } from 'firebase/firestore';

// --- CONFIGURACIÓN DE FIREBASE Y VARIABLES GLOBALES (MANDATORIO) ---
const firebaseConfig = typeof _firebase_config !== 'undefined' ? JSON.parse(_firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-macrosearch-app';
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
// --- FIN DE CONFIGURACIÓN DE FIREBASE ---

// Custom Hook para manejar la lógica de Firebase
const useFirebase = () => {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);

    useEffect(() => {
        if (!Object.keys(firebaseConfig).length) {
            console.error("Firebase config is missing.");
            return;
        }

        const app = initializeApp(firebaseConfig);
        const firestore = getFirestore(app);
        const authInstance = getAuth(app);

        setDb(firestore);
        setAuth(authInstance);

        const unsubscribe = onAuthStateChanged(authInstance, (user) => {
            if (user) {
                setUserId(user.uid);
                setIsAuthReady(true);
            } else {
                // Si no hay token inicial, intentar inicio de sesión anónimo
                if (!initialAuthToken) {
                    signInAnonymously(authInstance).then((credential) => {
                        setUserId(credential.user.uid);
                        setIsAuthReady(true);
                    }).catch(error => {
                        console.error("Error signing in anonymously:", error);
                        setIsAuthReady(true); // Aunque falló, la auth ha terminado
                    });
                }
            }
        });

        // Intentar inicio de sesión con token custom si está disponible
        if (initialAuthToken) {
            signInWithCustomToken(authInstance, initialAuthToken).then((credential) => {
                setUserId(credential.user.uid);
                setIsAuthReady(true);
            }).catch(error => {
                console.error("Error signing in with custom token:", error);
                // Si falla el token, intentar anónimo
                signInAnonymously(authInstance).then((credential) => {
                    setUserId(credential.user.uid);
                    setIsAuthReady(true);
                }).catch(err => {
                    console.error("Error signing in anonymously after token failure:", err);
                    setIsAuthReady(true);
                });
            });
        }

        return () => unsubscribe();
    }, []);

    return { db, userId, isAuthReady };
};

// Constante para la URL de la imagen del logo cargado
const LOGO_URL = "uploaded:Imagen de WhatsApp 2025-12-01 a las 04.00.31_c74834a8.jpg-26512028-7436-4c81-802c-3a4d70b4d0bd";

// Componente principal de la aplicación
const App = () => {
    const { db, userId, isAuthReady } = useFirebase();
    const [imageFile, setImageFile] = useState(null);
    const [base64Image, setBase64Image] = useState(null);
    const [analysisResult, setAnalysisResult] = useState(null);
    const [history, setHistory] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('upload'); // 'upload' o 'history'

    // Componente del logo: Usa la imagen cargada directamente
    const MacroSearchLogo = () => (
        <img
            src={LOGO_URL}
            alt="MacroSearch UTN-IMRH Logo"
            className="h-12 w-auto" // Aumentado el tamaño para que sea más visible en la parte superior
            onError={(e) => { e.target.onerror = null; e.target.src = "https://placehold.co/120x40/ffffff/0e7490?text=MacroSearch"; }}
        />
    );

    // --- LÓGICA DE FIREBASE FIRESTORE ---

    // Colección de análisis de usuario (ruta privada)
    const getAnalysisCollectionRef = useCallback(() => {
        if (db && userId) {
            return collection(db, artifacts/${appId}/users/${userId}/analyses);
        }
        return null;
    }, [db, userId]);

    // 1. Cargar Historial (Tiempo Real con onSnapshot)
    useEffect(() => {
        if (!isAuthReady || !db || !userId) return;

        const collectionRef = getAnalysisCollectionRef();
        if (!collectionRef) return;

        // Consultar ordenado por fecha descendente
        const q = query(collectionRef, orderBy('timestamp', 'desc'));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const analyses = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            setHistory(analyses);
        }, (error) => {
            console.error("Error al cargar el historial:", error);
            setError("Error al cargar el historial de Firebase.");
        });

        return () => unsubscribe();
    }, [isAuthReady, db, userId, getAnalysisCollectionRef]);

    // 2. Guardar un Análisis
    const saveAnalysis = useCallback(async (analysisData, imageUrl) => {
        if (!db || !userId) return;

        try {
            const collectionRef = getAnalysisCollectionRef();
            if (!collectionRef) throw new Error("Referencia de colección no disponible.");

            await addDoc(collectionRef, {
                ...analysisData,
                imageUrl: imageUrl, // Guardamos el Base64 para mostrar en el historial
                timestamp: serverTimestamp(),
            });
            console.log("Análisis guardado exitosamente.");
        } catch (e) {
            console.error("Error al guardar el análisis en Firestore: ", e);
            // Mostrar un error en la interfaz si es crítico
            setError("No se pudo guardar el análisis en el historial.");
        }
    }, [db, userId, getAnalysisCollectionRef]);

    // --- LÓGICA DE CARGA DE IMAGEN ---

    const handleImageChange = (event) => {
        const file = event.target.files[0];
        if (file) {
            if (file.size > 5 * 1024 * 1024) { // Limite de 5MB
                setError("La imagen es demasiado grande. Por favor, usa un archivo menor a 5MB.");
                setImageFile(null);
                setBase64Image(null);
                return;
            }

            setImageFile(file);
            setAnalysisResult(null); // Limpiar resultados anteriores

            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                setBase64Image(base64);
            };
            reader.readAsDataURL(file);
        }
    };

    // --- LÓGICA DE LA API GEMINI (VISION + ESTRUCTURADO) ---

    const analyzeImage = useCallback(async () => {
        if (!base64Image || !isAuthReady) {
            setError("Por favor, sube una imagen primero.");
            return;
        }

        setIsLoading(true);
        setError(null);
        setAnalysisResult(null);

        // Estructura de esquema JSON deseada para el análisis
        const responseSchema = {
            type: "OBJECT",
            properties: {
                nombreCientifico: { "type": "STRING", "description": "Nombre científico (ej. Ephemeroptera o el más específico posible)" },
                nombreComun: { "type": "STRING", "description": "Nombre común (ej. Mosca de mayo, si aplica)" },
                informacionBasica: { "type": "STRING", "description": "Una descripción concisa y relevante del macroinvertebrado, su hábitat y tamaño." },
                clasificacion: {
                    "type": "OBJECT",
                    "properties": {
                        "orden": { "type": "STRING" },
                        "familia": { "type": "STRING" },
                        "clase": { "type": "STRING" }
                    },
                    "description": "Clasificación taxonómica principal."
                },
                significadoEcologico: { "type": "STRING", "description": "Su rol como bioindicador de la calidad del agua (ej. Sensible a la contaminación, tolerante)." }
            },
            "required": ["nombreCientifico", "nombreComun", "informacionBasica", "clasificacion", "significadoEcologico"]
        };

        const userPrompt = "Identifica el macroinvertebrado acuático en esta imagen. Proporciona su nombre, información básica, clasificación taxonómica y su significado como bioindicador. Formatea la respuesta como JSON estricto siguiendo el esquema proporcionado.";

        const payload = {
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: userPrompt },
                        {
                            inlineData: {
                                mimeType: imageFile.type || "image/jpeg", // Usar el tipo de archivo real
                                data: base64Image
                            }
                        }
                    ]
                }
            ],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: responseSchema
            }
        };

        const apiKey = "";
        const apiUrl = https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey};

        // Implementación de reintento con retroceso exponencial
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    throw new Error(HTTP error! status: ${response.status});
                }

                const result = await response.json();
                const candidate = result.candidates?.[0];

                if (candidate && candidate.content?.parts?.[0]?.text) {
                    const jsonText = candidate.content.parts[0].text;
                    const parsedJson = JSON.parse(jsonText);

                    setAnalysisResult(parsedJson);

                    // Guardar en el historial
                    const imageUrl = data:${imageFile.type};base64,${base64Image};
                    await saveAnalysis(parsedJson, imageUrl);

                    setIsLoading(true);
                    return; // Éxito
                } else {
                    throw new Error("Respuesta de Gemini inválida o vacía.");
                }
            } catch (e) {
                lastError = e;
                console.error(Intento ${attempt + 1} fallido:, e);
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000)); // 1s, 2s
                
            }
        }

        setError(Error al comunicarse con Gemini: ${lastError.message || "Fallo después de múltiples reintentos."});
        setIsLoading(false);

    }, [base64Image, imageFile, isAuthReady, saveAnalysis]);


    // Componente para renderizar el resultado del análisis
    const AnalysisCard = ({ analysis, isHistory = false }) => (
        <div className={p-6 rounded-2xl shadow-xl ${isHistory ? 'bg-white/90 border border-sky-100' : 'bg-sky-50 border border-sky-200'}}>
            <h3 className="text-2xl font-extrabold text-sky-700 mb-2">
                {analysis.nombreCientifico}
            </h3>
            <p className="text-lg italic text-sky-500 mb-4">{analysis.nombreComun}</p>

            <div className="space-y-4">
                {/* Información Básica */}
                <div>
                    <h4 className="font-semibold text-sky-800 border-b pb-1 mb-1">Información Básica</h4>
                    <p className="text-gray-700 leading-relaxed">{analysis.informacionBasica}</p>
                </div>

                {/* Clasificación */}
                <div>
                    <h4 className="font-semibold text-sky-800 border-b pb-1 mb-1">Clasificación Taxonómica</h4>
                    <ul className="list-disc list-inside text-gray-700 ml-2">
                        <li>*Clase:* {analysis.clasificacion?.clase || 'N/A'}</li>
                        <li>*Orden:* {analysis.clasificacion?.orden || 'N/A'}</li>
                        <li>*Familia:* {analysis.clasificacion?.familia || 'N/A'}</li>
                    </ul>
                </div>

                {/* Significado Ecológico */}
                <div>
                    <h4 className="font-semibold text-sky-800 border-b pb-1 mb-1">Significado Ecológico (Bioindicador)</h4>
                    <p className="text-gray-700 leading-relaxed">{analysis.significadoEcologico}</p>
                </div>
            </div>
            {isHistory && (
                <p className="text-xs text-gray-400 mt-4 text-right">
                    Analizado el: {analysis.timestamp?.toDate ? analysis.timestamp.toDate().toLocaleDateString() : 'N/A'}
                </p>
            )}
        </div>
    );

    // Renderizado del historial
    const HistoryView = useMemo(() => (
        <div className="p-4 sm:p-6 lg:p-8">
            <h2 className="text-3xl font-bold text-sky-800 mb-6 border-b pb-2">Historial de Análisis ({history.length})</h2>
            <p className='text-sm text-gray-500 mb-6'>
                ID de Usuario: <span className='font-mono text-xs p-1 bg-gray-100 rounded'>{userId || 'Cargando...'}</span>
            </p>
            {isLoading && (<div className="text-center text-sky-600 my-4">Cargando historial...</div>)}
            {!isAuthReady && (<div className="text-center text-red-500 my-4">Autenticando...</div>)}
            {error && activeTab === 'history' && <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4" role="alert">{error}</div>}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {history.map((item) => (
                    <div key={item.id} className="flex flex-col bg-white rounded-xl shadow-lg hover:shadow-2xl transition duration-300">
                        <div className="w-full h-40 bg-gray-100 rounded-t-xl overflow-hidden flex items-center justify-center border-b border-sky-100">
                            <img
                                src={item.imageUrl}
                                alt="Imagen analizada"
                                className="object-cover w-full h-full"
                                onError={(e) => { e.target.onerror = null; e.target.src = "https://placehold.co/400x200/e0f2f7/0e7490?text=Macro+N/A"; }}
                            />
                        </div>
                        <div className='p-4'>
                            <AnalysisCard analysis={item} isHistory={true} />
                        </div>
                    </div>
                ))}
                {history.length === 0 && isAuthReady && (
                    <p className="text-gray-500 md:col-span-3 text-center py-12">Aún no tienes análisis. ¡Ve a la pestaña 'Analizar' para empezar!</p>
                )}
            </div>
        </div>
    ), [history, isLoading, isAuthReady, error, activeTab, userId]);


    // Renderizado principal
    return (
        <div className="min-h-screen bg-sky-50 font-sans antialiased text-gray-800">
            {/* Header */}
            <header className="bg-white shadow-md sticky top-0 z-10">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
                    <div className="flex items-center">
                        <MacroSearchLogo />
                        {/* El nombre del título ya está incluido en la imagen del logo, lo quitamos de aquí */}
                        {/* <h1 className="text-3xl font-bold text-sky-800">MacroSearch</h1> */}
                    </div>
                    <nav className="flex space-x-4">
                        <button
                            onClick={() => setActiveTab('upload')}
                            className={`px-4 py-2 rounded-full font-medium transition duration-300 ${
                                activeTab === 'upload' ? 'bg-sky-600 text-white shadow-lg' : 'text-sky-600 hover:bg-sky-100'
                            }`}
                        >
                            Analizar
                        </button>
                        <button
                            onClick={() => setActiveTab('history')}
                            className={`px-4 py-2 rounded-full font-medium transition duration-300 ${
                                activeTab === 'history' ? 'bg-sky-600 text-white shadow-lg' : 'text-sky-600 hover:bg-sky-100'
                            }`}
                        >
                            Historial
                        </button>
                    </nav>
                </div>
            </header>

            <main className="max-w-7xl mx-auto pb-12">
                {activeTab === 'upload' && (
                    <div className="p-4 sm:p-6 lg:p-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
                        {/* Columna de Carga y Resultados */}
                        <div className="lg:col-span-1 space-y-8">
                            <div className="bg-white p-6 rounded-2xl shadow-xl border border-sky-100">
                                <h2 className="text-2xl font-bold text-sky-800 mb-4">1. Cargar Imagen</h2>

                                {!isAuthReady && (
                                    <div className="bg-yellow-100 border border-yellow-400 text-yellow-700 px-4 py-3 rounded mb-4 text-sm">
                                        Conectando a Firebase...
                                    </div>
                                )}

                                <div className="flex flex-col items-center justify-center border-2 border-sky-300 border-dashed rounded-xl p-8 transition duration-300 hover:bg-sky-50/50">
                                    {base64Image ? (
                                        <img src={data:${imageFile.type};base64,${base64Image}} alt="Preview" className="max-h-64 w-auto rounded-lg shadow-md mb-4 object-contain" />
                                    ) : (
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-sky-400 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-9-2h.01M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                        </svg>
                                    )}
                                    <input
                                        type="file"
                                        accept="image/png, image/jpeg"
                                        onChange={handleImageChange}
                                        className="text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-sky-50 file:text-sky-700 hover:file:bg-sky-100"
                                        disabled={!isAuthReady}
                                    />
                                </div>

                                <button
                                    onClick={analyzeImage}
                                    className="w-full mt-6 flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-xl text-white bg-sky-600 hover:bg-sky-700 disabled:bg-sky-400 shadow-lg transition duration-300 transform hover:scale-[1.01]"
                                    disabled={!base64Image || isLoading || !isAuthReady}
                                >
                                    {isLoading ? (
                                        <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                    ) : 'Analizar Macroinvertebrado'}
                                </button>
                                {error && <div className="mt-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded text-sm" role="alert">{error}</div>}
                            </div>
                        </div>

                        {/* Columna de Resultados del Análisis */}
                        <div className="lg:col-span-2">
                            <div className="bg-white p-6 rounded-2xl shadow-xl border border-sky-100 min-h-[400px]">
                                <h2 className="text-2xl font-bold text-sky-800 mb-6">2. Resultados de la Identificación</h2>
                                {analysisResult ? (
                                    <AnalysisCard analysis={analysisResult} isHistory={false} />
                                ) : isLoading ? (
                                    <div className="flex flex-col items-center justify-center h-full pt-16">
                                        <svg className="animate-spin h-8 w-8 text-sky-600 mb-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        <p className="text-sky-600">Analizando imagen y generando informe...</p>
                                    </div>
                                ) : (
                                    <div className="flex flex-col items-center justify-center h-full pt-16 text-center text-gray-400">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                        </svg>
                                        <p>Sube una imagen de un macroinvertebrado para iniciar el análisis.</p>
                                        <p className="mt-2 text-sm">El resultado aparecerá aquí y se guardará automáticamente en el historial.</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
                {activeTab === 'history' && HistoryView}
            </main>
            {/* Footer con info de Usuario/App */}
            <footer className="bg-sky-900 text-white text-xs p-3 text-center">
                <p>MacroSearch UTN & IMRH</p>
            </footer>
        </div>
    );
};

export default App;
